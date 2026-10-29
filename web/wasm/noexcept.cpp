// The distro's wasm32 libc++ is built expecting exception support in a few
// places (e.g. operator new throwing bad_alloc). The browser build has no
// exceptions, so those paths report and stop instead.
#include <cstddef>
#include <cstdlib>
#include <cstring>

extern "C" __attribute__((import_module("env"), import_name("sk_log"))) void js_log(const char* msg, int len);

extern "C" void* __cxa_allocate_exception(std::size_t) {
  const char* m = "synthkit: out of memory (or another C++ exception) in the browser build";
  js_log(m, static_cast<int>(std::strlen(m)));
  std::abort();
}

extern "C" void __cxa_throw(void*, void*, void (*)(void*)) { std::abort(); }
