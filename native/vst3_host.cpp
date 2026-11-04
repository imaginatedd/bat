// vst3_host.cpp
// Minimal VST3 host bridge: loads a .vst3, enumerates/reads/writes parameters,
// and processes audio blocks through the plugin over a line protocol on
// stdin/stdout. Used by the Electron main process.
//
// Audio is exchanged MONO: the host up-mixes the mono input to the plugin's
// input channel count and down-mixes the plugin's output back to mono. This
// hides the plugin's channel configuration from the Electron side.
//
// Input commands (one per line, tab-separated):
//   load\t<path>                  load a .vst3 file
//   setup\t<sampleRate>\t<blockSize>  configure the audio processor
//   get\t<paramId>                read one parameter (normalized 0..1)
//   set\t<paramId>\t<value>       write one parameter (normalized 0..1)
//   process\t<numSamples>\t<base64>   process a mono float32 block (LE)
//   unload                        release the loaded plugin
//   quit                          exit
//
// Output: one JSON object per line (UTF-8):
//   {"type":"loaded","params":[...],"numInCh":2,"numOutCh":2}
//   {"type":"ready"}
//   {"type":"param","id":1,"value":0.5}
//   {"type":"audio","numSamples":128,"data":"<base64 mono float32>"}
//   {"type":"unloaded"}
//   {"type":"error","message":"..."}
//
// Build instructions: see README.md. Targets the Steinberg VST3 SDK (3.7.x).

#include "pluginterfaces/base/funknown.h"
#include "pluginterfaces/base/ipluginbase.h"
#include "pluginterfaces/vst/ivstcomponent.h"
#include "pluginterfaces/vst/ivsteditcontroller.h"
#include "pluginterfaces/vst/ivstaudioprocessor.h"
#include "pluginterfaces/vst/ivsthostapplication.h"
#include "pluginterfaces/vst/ivstcomponenthandler.h"
#include "base/source/fobject.h"

#include <windows.h>

#include <cstdint>
#include <cstring>
#include <cstdio>
#include <iostream>
#include <sstream>
#include <string>
#include <vector>

using namespace Steinberg;
using namespace Steinberg::Vst;

// --- UTF helpers -----------------------------------------------------------

static std::string utf16ToUtf8(const TChar* w) {
  if (!w) return "";
  int n = WideCharToMultiByte(CP_UTF8, 0, (LPCWCH)w, -1, nullptr, 0, nullptr, nullptr);
  if (n <= 0) return "";
  std::string out((size_t)(n - 1), '\0');
  WideCharToMultiByte(CP_UTF8, 0, (LPCWCH)w, -1, &out[0], n, nullptr, nullptr);
  return out;
}

static std::wstring utf8ToWide(const std::string& s) {
  if (s.empty()) return L"";
  int n = MultiByteToWideChar(CP_UTF8, 0, s.c_str(), (int)s.size(), nullptr, 0);
  if (n <= 0) return L"";
  std::wstring out((size_t)n, L'\0');
  MultiByteToWideChar(CP_UTF8, 0, s.c_str(), (int)s.size(), &out[0], n);
  return out;
}

static std::string jsonEscape(const std::string& s) {
  std::string o;
  o.reserve(s.size() + 8);
  for (char c : s) {
    switch (c) {
      case '"': o += "\\\""; break;
      case '\\': o += "\\\\"; break;
      case '\n': o += "\\n"; break;
      case '\r': o += "\\r"; break;
      case '\t': o += "\\t"; break;
      default:
        if ((unsigned char)c < 0x20) {
          char buf[8];
          std::snprintf(buf, sizeof(buf), "\\u%04x", (unsigned char)c);
          o += buf;
        } else {
          o += c;
        }
    }
  }
  return o;
}

// --- Base64 ----------------------------------------------------------------

static const char kB64[] =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

static std::string base64Encode(const uint8_t* data, size_t len) {
  std::string out;
  out.reserve(((len + 2) / 3) * 4);
  for (size_t i = 0; i < len; i += 3) {
    uint32_t n = (uint32_t)data[i] << 16;
    if (i + 1 < len) n |= (uint32_t)data[i + 1] << 8;
    if (i + 2 < len) n |= (uint32_t)data[i + 2];
    out += kB64[(n >> 18) & 63];
    out += kB64[(n >> 12) & 63];
    out += (i + 1 < len) ? kB64[(n >> 6) & 63] : '=';
    out += (i + 2 < len) ? kB64[n & 63] : '=';
  }
  return out;
}

static std::vector<uint8_t> base64Decode(const std::string& s) {
  auto val = [](char c) -> int {
    if (c >= 'A' && c <= 'Z') return c - 'A';
    if (c >= 'a' && c <= 'z') return c - 'a' + 26;
    if (c >= '0' && c <= '9') return c - '0' + 52;
    if (c == '+') return 62;
    if (c == '/') return 63;
    return -1;
  };
  std::vector<uint8_t> out;
  out.reserve((s.size() * 3) / 4);
  int buf = 0, bits = 0;
  for (char c : s) {
    if (c == '=' || c == '\n' || c == '\r') continue;
    int v = val(c);
    if (v < 0) continue;
    buf = (buf << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push_back((uint8_t)((buf >> bits) & 0xFF));
    }
  }
  return out;
}

// --- Host context ----------------------------------------------------------

class HostContext : public FObject,
                    public IComponentHandler,
                    public IHostApplication {
 public:
  tresult PLUGIN_API beginEdit(ParamID) override { return kResultOk; }
  tresult PLUGIN_API performEdit(ParamID, ParamValue) override { return kResultOk; }
  tresult PLUGIN_API endEdit(ParamID) override { return kResultOk; }
  tresult PLUGIN_API restartComponent(int32) override { return kResultOk; }

  tresult PLUGIN_API getName(String128 name) override;
  tresult PLUGIN_API createInstance(TUID, TUID, void** obj) override {
    if (obj) *obj = nullptr;
    return kResultFalse;
  }

  OBJ_METHODS(HostContext, FObject)
  DEFINE_INTERFACES
    DEF_INTERFACE(IComponentHandler)
    DEF_INTERFACE(IHostApplication)
  END_DEFINE_INTERFACES(FObject)
  REFCOUNT_METHODS(FObject)
};

tresult PLUGIN_API HostContext::getName(String128 name) {
  const char* s = "Vst3Host";
  for (int i = 0; i < 128; i++) name[i] = 0;
  for (int i = 0; s[i] && i < 127; i++) name[i] = (TChar)s[i];
  return kResultOk;
}

// --- Loaded plugin ---------------------------------------------------------

struct Plugin {
  HMODULE module = nullptr;
  IPluginFactory* factory = nullptr;
  IComponent* component = nullptr;
  IEditController* controller = nullptr;
  IAudioProcessor* processor = nullptr;
  HostContext* hostContext = nullptr;

  int32 numInCh = 0;
  int32 numOutCh = 0;
  bool processing = false;

  ~Plugin() { unload(); }

  void unload() {
    if (component) {
      component->setActive(false);
      component->terminate();
      component->release();
      component = nullptr;
    }
    if (controller) {
      controller->terminate();
      controller->release();
      controller = nullptr;
    }
    if (factory) {
      factory->release();
      factory = nullptr;
    }
    if (processor) {
      processor->release();
      processor = nullptr;
    }
    if (hostContext) {
      hostContext->release();
      hostContext = nullptr;
    }
    if (module) {
      FreeLibrary(module);
      module = nullptr;
    }
    processing = false;
  }
};

static bool loadPlugin(Plugin& p, const std::string& path) {
  p.unload();

  std::wstring wpath = utf8ToWide(path);
  p.module = LoadLibraryW(wpath.c_str());
  if (!p.module) return false;

  typedef bool(PLUGIN_API* GetFactoryProc)(IPluginFactory**);
  auto entry = (GetFactoryProc)GetProcAddress(p.module, "GetPluginFactory");
  if (!entry) {
    p.unload();
    return false;
  }

  IPluginFactory* factory = nullptr;
  if (!entry(&factory) || !factory) {
    p.unload();
    return false;
  }
  p.factory = factory;

  TUID cid;
  bool found = false;
  for (int32 i = 0; i < factory->countClasses(); i++) {
    PClassInfo ci;
    if (factory->getClassInfo(i, &ci) == kResultOk) {
      if (std::strcmp(ci.category, "Audio Effect") == 0) {
        std::memcpy(cid, ci.cid, sizeof(TUID));
        found = true;
        break;
      }
    }
  }
  if (!found) {
    p.unload();
    return false;
  }

  p.hostContext = new HostContext();

  IComponent* component = nullptr;
  IEditController* controller = nullptr;

  FUID cidF;
  cidF.fromTUID(cid);
  if (factory->createInstance(cidF, IComponent::iid, (void**)&component) != kResultOk || !component) {
    p.unload();
    return false;
  }
  if (factory->createInstance(cidF, IEditController::iid, (void**)&controller) != kResultOk || !controller) {
    p.unload();
    return false;
  }

  p.component = component;
  p.controller = controller;

  component->initialize(p.hostContext);
  controller->initialize(p.hostContext);
  controller->setComponentHandler(p.hostContext);

  // Audio processor (required for audio effects).
  IAudioProcessor* processor = nullptr;
  if (component->queryInterface(IAudioProcessor::iid, (void**)&processor) != kResultOk || !processor) {
    p.unload();
    return false;
  }
  p.processor = processor;

  // Activate all audio buses and read the first bus channel counts.
  for (int32 i = 0; i < component->getBusCount(kAudio, kInput); i++) {
    component->activateBus(kAudio, kInput, i, true);
  }
  for (int32 i = 0; i < component->getBusCount(kAudio, kOutput); i++) {
    component->activateBus(kAudio, kOutput, i, true);
  }
  if (component->getBusCount(kAudio, kInput) > 0) {
    BusInfo bi = {};
    if (component->getBusInfo(kAudio, kInput, 0, &bi) == kResultOk) p.numInCh = bi.channelCount;
  }
  if (component->getBusCount(kAudio, kOutput) > 0) {
    BusInfo bi = {};
    if (component->getBusInfo(kAudio, kOutput, 0, &bi) == kResultOk) p.numOutCh = bi.channelCount;
  }
  if (p.numInCh <= 0 || p.numOutCh <= 0) {
    p.unload();
    return false;
  }

  component->setActive(true);
  return true;
}

static void emitParams(Plugin& p) {
  IEditController* ctrl = p.controller;
  std::ostringstream js;
  js << "{\"type\":\"loaded\",\"numInCh\":" << p.numInCh
     << ",\"numOutCh\":" << p.numOutCh
     << ",\"params\":[";
  int32 n = ctrl->getParameterCount();
  bool first = true;
  for (int32 i = 0; i < n; i++) {
    ParameterInfo info = {};
    if (ctrl->getParameterInfo(i, &info) == kResultOk) {
      if (!first) js << ",";
      first = false;
      ParamValue v = ctrl->getParamNormalized(info.id);
      js << "{\"id\":" << (uint64_t)info.id
         << ",\"title\":\"" << jsonEscape(utf16ToUtf8(info.title)) << "\""
         << ",\"value\":" << v
         << ",\"units\":\"" << jsonEscape(utf16ToUtf8(info.units)) << "\"}";
    }
  }
  js << "]}";
  std::cout << js.str() << "\n" << std::flush;
}

static bool setupProcessing(Plugin& p, double sampleRate, int32 blockSize) {
  if (!p.processor) return false;
  ProcessSetup setup = {};
  setup.processMode = kRealtime;
  setup.symbolicSampleSize = kSample32;
  setup.maxSamplesPerBlock = blockSize;
  setup.sampleRate = sampleRate;
  if (p.processor->setupProcessing(setup) != kResultOk) return false;
  if (p.processor->setProcessing(true) != kResultOk) return false;
  p.processing = true;
  return true;
}

static void processAudio(Plugin& p, int32 numSamples, const std::string& b64) {
  if (!p.processor || !p.processing) {
    std::cout << "{\"type\":\"error\",\"message\":\"processor not ready\"}\n" << std::flush;
    return;
  }

  std::vector<uint8_t> bytes = base64Decode(b64);
  if (bytes.size() < (size_t)numSamples * 4) {
    std::cout << "{\"type\":\"error\",\"message\":\"bad audio payload\"}\n" << std::flush;
    return;
  }
  const float* mono = reinterpret_cast<const float*>(bytes.data());

  // Up-mix mono -> plugin input channels.
  std::vector<std::vector<float>> in((size_t)p.numInCh, std::vector<float>((size_t)numSamples, 0.f));
  for (int32 s = 0; s < numSamples; s++) {
    for (int32 c = 0; c < p.numInCh; c++) in[c][s] = mono[s];
  }
  std::vector<std::vector<float>> out((size_t)p.numOutCh, std::vector<float>((size_t)numSamples, 0.f));

  std::vector<float*> inPtrs((size_t)p.numInCh), outPtrs((size_t)p.numOutCh);
  for (int32 c = 0; c < p.numInCh; c++) inPtrs[c] = in[c].data();
  for (int32 c = 0; c < p.numOutCh; c++) outPtrs[c] = out[c].data();

  AudioBusBuffers inBus = {};
  inBus.numChannels = p.numInCh;
  inBus.channelBuffers32 = inPtrs.data();
  AudioBusBuffers outBus = {};
  outBus.numChannels = p.numOutCh;
  outBus.channelBuffers32 = outPtrs.data();

  ProcessData data = {};
  data.processMode = kRealtime;
  data.symbolicSampleSize = kSample32;
  data.numSamples = numSamples;
  data.numInputs = 1;
  data.numOutputs = 1;
  data.inputs = &inBus;
  data.outputs = &outBus;

  p.processor->process(data);

  // Down-mix plugin output -> mono.
  std::vector<float> monoOut((size_t)numSamples, 0.f);
  for (int32 s = 0; s < numSamples; s++) {
    float acc = 0.f;
    for (int32 c = 0; c < p.numOutCh; c++) acc += out[c][s];
    monoOut[s] = acc / (float)p.numOutCh;
  }

  std::string outB64 = base64Encode((const uint8_t*)monoOut.data(), monoOut.size() * 4);
  std::cout << "{\"type\":\"audio\",\"numSamples\":" << numSamples
            << ",\"data\":\"" << outB64 << "\"}\n" << std::flush;
}

int main() {
  Plugin plugin;
  std::string line;
  while (std::getline(std::cin, line)) {
    if (!line.empty() && line.back() == '\r') line.pop_back();

    size_t tab1 = line.find('\t');
    std::string cmd = (tab1 == std::string::npos) ? line : line.substr(0, tab1);
    std::string rest = (tab1 == std::string::npos) ? "" : line.substr(tab1 + 1);

    if (cmd == "load") {
      if (loadPlugin(plugin, rest)) {
        emitParams(plugin);
      } else {
        std::cout << "{\"type\":\"error\",\"message\":\"failed to load plugin\"}\n" << std::flush;
      }
    } else if (cmd == "setup") {
      size_t tab2 = rest.find('\t');
      double sampleRate = std::stod(rest.substr(0, tab2));
      int32 blockSize = (int32)std::stoi(rest.substr(tab2 + 1));
      if (setupProcessing(plugin, sampleRate, blockSize)) {
        std::cout << "{\"type\":\"ready\"}\n" << std::flush;
      } else {
        std::cout << "{\"type\":\"error\",\"message\":\"setup failed\"}\n" << std::flush;
      }
    } else if (cmd == "process") {
      size_t tab2 = rest.find('\t');
      int32 numSamples = (int32)std::stoi(rest.substr(0, tab2));
      processAudio(plugin, numSamples, rest.substr(tab2 + 1));
    } else if (cmd == "get") {
      if (!plugin.controller) {
        std::cout << "{\"type\":\"error\",\"message\":\"no plugin loaded\"}\n" << std::flush;
      } else {
        ParamID id = (ParamID)std::stoul(rest);
        ParamValue v = plugin.controller->getParamNormalized(id);
        std::cout << "{\"type\":\"param\",\"id\":" << (uint64_t)id << ",\"value\":" << v << "}\n" << std::flush;
      }
    } else if (cmd == "set") {
      if (!plugin.controller) {
        std::cout << "{\"type\":\"error\",\"message\":\"no plugin loaded\"}\n" << std::flush;
      } else {
        size_t tab2 = rest.find('\t');
        ParamID id = (ParamID)std::stoul(rest.substr(0, tab2));
        ParamValue v = (ParamValue)std::stod(rest.substr(tab2 + 1));
        tresult r = plugin.controller->setParamNormalized(id, v);
        if (r == kResultOk) {
          std::cout << "{\"type\":\"param\",\"id\":" << (uint64_t)id << ",\"value\":" << v << "}\n" << std::flush;
        } else {
          std::cout << "{\"type\":\"error\",\"message\":\"set failed\"}\n" << std::flush;
        }
      }
    } else if (cmd == "unload") {
      plugin.unload();
      std::cout << "{\"type\":\"unloaded\"}\n" << std::flush;
    } else if (cmd == "quit") {
      break;
    } else {
      std::cout << "{\"type\":\"error\",\"message\":\"unknown command\"}\n" << std::flush;
    }
  }

  plugin.unload();
  return 0;
}
