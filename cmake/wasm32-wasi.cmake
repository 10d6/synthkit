# Toolchain for the browser build: clang targeting wasm32-wasi, using the
# distro's wasi-libc and libc++ (Ubuntu 24.04: wasi-libc, libc++-18-dev-wasm32,
# libclang-rt-18-dev-wasm32, lld-18).
#
#   cmake -S . -B build-web -G Ninja -DCMAKE_TOOLCHAIN_FILE=cmake/wasm32-wasi.cmake

set(CMAKE_SYSTEM_NAME Generic)
set(CMAKE_SYSTEM_PROCESSOR wasm32)

if(NOT SYNTHKIT_WASM_CLANG)
  find_program(SYNTHKIT_WASM_CLANG NAMES clang++-18 clang++-19 clang++-20 clang++ REQUIRED)
endif()
set(CMAKE_CXX_COMPILER "${SYNTHKIT_WASM_CLANG}")
set(CMAKE_CXX_COMPILER_TARGET wasm32-wasi)
set(CMAKE_CXX_FLAGS_INIT "-fno-exceptions")
set(CMAKE_EXECUTABLE_SUFFIX ".wasm")
set(CMAKE_TRY_COMPILE_TARGET_TYPE STATIC_LIBRARY)

set(SYNTHKIT_WASM ON CACHE BOOL "Building synthkit for the browser" FORCE)
