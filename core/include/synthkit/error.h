// Definition-time errors (bad synth.json, duplicate parameter IDs, …).
// Native builds throw std::invalid_argument, so tests and the render tool
// can report them. Builds without exceptions (WebAssembly) call the error
// handler and then abort, since these are bugs to fix rather than conditions
// to recover from.
#pragma once

#include <string>

#if defined(__cpp_exceptions) || defined(__EXCEPTIONS) || defined(_CPPUNWIND)
#define SK_HAS_EXCEPTIONS 1
#else
#define SK_HAS_EXCEPTIONS 0
#endif

// The browser build has no threads: the engine lives entirely on the
// AudioWorklet thread.
#if defined(__wasm__) && !defined(__wasm_atomics__)
#define SK_SINGLE_THREADED 1
#else
#define SK_SINGLE_THREADED 0
#endif

namespace sk {

using ErrorHandler = void (*)(const char* message);
void setErrorHandler(ErrorHandler handler);

[[noreturn]] void fail(const std::string& message);

}  // namespace sk
