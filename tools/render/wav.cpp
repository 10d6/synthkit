#include "wav.h"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdio>

namespace skr {

namespace {
void u32(std::FILE* f, uint32_t v) { for (int i = 0; i < 4; ++i) std::fputc(static_cast<int>((v >> (8 * i)) & 0xFF), f); }
void u16(std::FILE* f, uint16_t v) { std::fputc(v & 0xFF, f); std::fputc((v >> 8) & 0xFF, f); }
}  // namespace

bool writeWav(const std::string& path, const std::vector<float>& l, const std::vector<float>& r, int sr) {
  std::FILE* f = std::fopen(path.c_str(), "wb");
  if (!f) return false;
  uint32_t frames = static_cast<uint32_t>(std::min(l.size(), r.size()));
  uint32_t data = frames * 2 * 3;
  std::fwrite("RIFF", 1, 4, f); u32(f, 36 + data); std::fwrite("WAVE", 1, 4, f);
  std::fwrite("fmt ", 1, 4, f); u32(f, 16); u16(f, 1); u16(f, 2); u32(f, static_cast<uint32_t>(sr));
  u32(f, static_cast<uint32_t>(sr) * 6); u16(f, 6); u16(f, 24);
  std::fwrite("data", 1, 4, f); u32(f, data);
  for (uint32_t i = 0; i < frames; ++i) {
    for (float x : {l[i], r[i]}) {
      double c = std::clamp(static_cast<double>(x), -1.0, 1.0);
      int32_t v = static_cast<int32_t>(std::lrint(c * 8388607.0));
      std::fputc(v & 0xFF, f); std::fputc((v >> 8) & 0xFF, f); std::fputc((v >> 16) & 0xFF, f);
    }
  }
  return std::fclose(f) == 0;
}

}  // namespace skr
