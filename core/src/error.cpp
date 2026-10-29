#include "synthkit/error.h"

#include <cstdio>
#include <cstdlib>
#include <stdexcept>

namespace sk {

namespace {
ErrorHandler gHandler = nullptr;
}

void setErrorHandler(ErrorHandler h) { gHandler = h; }

void fail(const std::string& message) {
#if SK_HAS_EXCEPTIONS
  throw std::invalid_argument(message);
#else
  if (gHandler) gHandler(message.c_str());
  else std::fprintf(stderr, "synthkit: %s\n", message.c_str());
  std::abort();
#endif
}

}  // namespace sk
