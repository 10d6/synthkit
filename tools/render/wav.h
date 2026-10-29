#pragma once

#include <string>
#include <vector>

namespace skr {

// Writes 24-bit PCM stereo. Returns false on I/O error.
bool writeWav(const std::string& path, const std::vector<float>& left, const std::vector<float>& right, int sampleRate);

}  // namespace skr
