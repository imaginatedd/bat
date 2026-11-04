# VST3 Host Bridge

Небольшая нативная программа, которая загружает реальный VST3-плагин и позволяет
читать/менять его параметры. Electron (main process) запускает её как дочерний
процесс и общается с ней по простому текстовому протоколу через stdin/stdout.

## Зачем нужна отдельная программа

VST3 — это нативный ABI (C++-интерфейсы, загружаемые DLL). Из JavaScript загрузить
и управлять плагином невозможно — нужен нативный хост. Этот хост и есть `vst3_host`.

## Сборка (Windows)

Нужны: **Visual Studio Build Tools** (или Visual Studio) с компилятором MSVC,
**CMake** и **VST3 SDK**.

1. Скачайте VST3 SDK:
   ```bash
   git clone --recursive https://github.com/steinbergmedia/vst3sdk.git
   ```
2. Соберите хост:
   ```powershell
   cd native
   cmake -S . -B build -DVST3_SDK_DIR=C:\path\to\vst3sdk
   cmake --build build --config Release
   ```
3. Получится `native/build/Release/vst3_host.exe`.

## Протокол

Одна команда на строку, разделитель — табуляция. Ответ — одна JSON-строка.

| Команда | Ответ |
|---|---|
| `load\t<путь>` | `{"type":"loaded","numInCh":2,"numOutCh":2,"params":[...]}` |
| `setup\t<sr>\t<blockSize>` | `{"type":"ready"}` |
| `get\t<id>` | `{"type":"param","id":1,"value":0.5}` |
| `set\t<id>\t<значение>` | `{"type":"param","id":1,"value":0.5}` |
| `process\t<numSamples>\t<base64>` | `{"type":"audio","numSamples":128,"data":"<base64>"}` |
| `unload` | `{"type":"unloaded"}` |
| ошибка | `{"type":"error","message":"..."}` |

Значения параметров — нормализованные `0.0..1.0`.

Аудио передаётся **моно** (float32 LE, base64): хост сам делает апмикс в число
входных каналов плагина и даунмикс выходных каналов обратно в моно. `process`
работает после `setup`.

## Примечания

- Код целится в VST3 SDK **3.7.x**. Если ваша версия SDK переименовала какой-то
  макрос `FUnknown` (`OBJ_METHODS` / `DEFINE_INTERFACES`) или метод
  `IHostApplication`, поправьте одно место в `vst3_host.cpp`.
- Для простоты загружается первый класс категории `Audio Effect`. Если нужно
  выбирать конкретный класс внутри плагина — расширьте протокол.
- Аудио-обработка реализована через `IAudioProcessor::process` (моно-интерфейс,
  см. таблицу протокола).
