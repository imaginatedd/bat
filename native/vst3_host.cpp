// vst3_host.cpp
// Minimal VST3 host bridge: loads a .vst3, enumerates/reads/writes parameters
// over a simple line protocol on stdin/stdout. Used by the Electron main process.
//
// Input commands (one per line, tab-separated):
//   load\t<path>                 load a .vst3 file
//   get\t<paramId>               read one parameter (normalized 0..1)
//   set\t<paramId>\t<value>      write one parameter (normalized 0..1)
//   unload                       release the loaded plugin
//   quit                         exit
//
// Output: one JSON object per line (UTF-8):
//   {"type":"loaded","params":[{"id":1,"title":"Gain","value":0.5,"units":"dB"}, ...]}
//   {"type":"param","id":1,"value":0.5}
//   {"type":"unloaded"}
//   {"type":"error","message":"..."}
//
// Build instructions: see README.md in this directory.
// Targets the Steinberg VST3 SDK (3.7.x). If your SDK version renames an
// FUnknown macro or IHostApplication method, adjust the single spot below.

#include "pluginterfaces/base/funknown.h"
#include "pluginterfaces/base/ipluginbase.h"
#include "pluginterfaces/vst/ivstcomponent.h"
#include "pluginterfaces/vst/ivsteditcontroller.h"
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

// --- Host context (implements the interfaces the plugin queries) -----------

class HostContext : public FObject,
                    public IComponentHandler,
                    public IHostApplication {
 public:
  // IComponentHandler
  tresult PLUGIN_API beginEdit(ParamID) override { return kResultOk; }
  tresult PLUGIN_API performEdit(ParamID, ParamValue) override { return kResultOk; }
  tresult PLUGIN_API endEdit(ParamID) override { return kResultOk; }
  tresult PLUGIN_API restartComponent(int32) override { return kResultOk; }

  // IHostApplication
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
  HostContext* hostContext = nullptr;

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
    if (hostContext) {
      hostContext->release();
      hostContext = nullptr;
    }
    if (module) {
      FreeLibrary(module);
      module = nullptr;
    }
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

  // Find the first audio-effect class (skip instruments/other categories).
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
  component->setActive(true);

  return true;
}

static void emitParams(Plugin& p) {
  IEditController* ctrl = p.controller;
  std::ostringstream js;
  js << "{\"type\":\"loaded\",\"params\":[";
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
