cmake_minimum_required(VERSION 3.22)
project(synthkit VERSION 0.1.0 LANGUAGES CXX)

set(SYNTHKIT_TOP_LEVEL OFF)
if(CMAKE_SOURCE_DIR STREQUAL PROJECT_SOURCE_DIR)
  set(SYNTHKIT_TOP_LEVEL ON)
endif()
option(SYNTHKIT_BUILD_EXAMPLES "Build the example synths" ${SYNTHKIT_TOP_LEVEL})
option(SYNTHKIT_BUILD_TESTS "Build synthkit's own tests" ${SYNTHKIT_TOP_LEVEL})
option(SYNTHKIT_PLUGIN "Build plugins (VST3/AU/Standalone) with JUCE" OFF)
if(SYNTHKIT_WASM)
  set(SYNTHKIT_BUILD_TESTS OFF)  # the tests run natively; the browser build is checked in Chromium
endif()

if(SYNTHKIT_TOP_LEVEL AND NOT CMAKE_BUILD_TYPE AND NOT CMAKE_CONFIGURATION_TYPES)
  set(CMAKE_BUILD_TYPE Release CACHE STRING "" FORCE)
endif()

add_library(synthkit_core STATIC
  core/src/error.cpp
  core/src/json.cpp
  core/src/params.cpp
  core/src/engine.cpp
  core/src/modulation.cpp)
target_include_directories(synthkit_core PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}/core/include")
target_compile_features(synthkit_core PUBLIC cxx_std_20)
if(MSVC)
  target_compile_options(synthkit_core PRIVATE /W4 /permissive-)
else()
  target_compile_options(synthkit_core PRIVATE -Wall -Wextra -Wpedantic -Wshadow)
endif()

include("${CMAKE_CURRENT_SOURCE_DIR}/cmake/synthkit.cmake")

if(SYNTHKIT_PLUGIN)
  # JUCE also compiles C (and Objective-C++ on macOS). A synth repo that
  # builds plugins enables these in its own top-level CMakeLists.txt.
  enable_language(C)
  if(APPLE)
    enable_language(OBJC OBJCXX)
  endif()
  include("${CMAKE_CURRENT_SOURCE_DIR}/cmake/plugin.cmake")
endif()

if(SYNTHKIT_BUILD_TESTS OR SYNTHKIT_BUILD_EXAMPLES)
  include(CTest)
endif()

if(SYNTHKIT_BUILD_TESTS)
  add_executable(synthkit_tests tests/core_tests.cpp)
  target_link_libraries(synthkit_tests PRIVATE synthkit_core)
  add_test(NAME synthkit_core_tests COMMAND synthkit_tests)
endif()

if(SYNTHKIT_BUILD_EXAMPLES)
  add_subdirectory(examples/basic)
endif()
