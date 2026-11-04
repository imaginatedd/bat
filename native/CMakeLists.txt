cmake_minimum_required(VERSION 3.16)
project(vst3_host CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Path to the Steinberg VST3 SDK checkout, e.g.:
#   git clone --recursive https://github.com/steinbergmedia/vst3sdk.git
# Pass it with:  cmake -DVST3_SDK_DIR=C:/path/to/vst3sdk ..
set(VST3_SDK_DIR "" CACHE PATH "Root of the Steinberg VST3 SDK")

if(NOT VST3_SDK_DIR)
  message(FATAL_ERROR "VST3_SDK_DIR is required: cmake -DVST3_SDK_DIR=<path-to-vst3sdk> ..")
endif()

add_executable(vst3_host vst3_host.cpp)

# SDK headers use paths like "pluginterfaces/...", "base/source/...",
# "public.sdk/source/...", all relative to the SDK root.
target_include_directories(vst3_host PRIVATE ${VST3_SDK_DIR})

if(WIN32)
  target_compile_definitions(vst3_host PRIVATE _CRT_SECURE_NO_WARNINGS NOMINMAX UNICODE _UNICODE)
endif()

# VST3 plugins are loaded at runtime via LoadLibrary; nothing VST-specific to link.
