// Messages between a synth's page and its engine (API.md §9b): small,
// declared, not saved in patches and not automatable. A held treadle, a
// "new reeds" button, a gauge reading. The audio thread sees each incoming
// message once, at the start of the next block; messages it posts reach the
// page within a few milliseconds.
#pragma once

#include <array>
#include <atomic>
#include <cstddef>
#include <initializer_list>
#include <string>
#include <vector>

namespace sk {

struct MessageId {
  int index = -1;
  bool valid() const { return index >= 0; }
  bool operator==(const MessageId& o) const { return index == o.index; }
};

// One message: which one, and up to four numbers.
struct Message {
  static constexpr int kMaxValues = 4;
  MessageId id;
  int count = 0;
  std::array<float, kMaxValues> values{};

  bool is(MessageId m) const { return id == m; }
  float operator[](int i) const { return i >= 0 && i < count ? values[static_cast<std::size_t>(i)] : 0.f; }
  float value(int i = 0) const { return (*this)[i]; }
};

class MessageBuilder {
 public:
  // A stable string id (letters, digits, '.', '-', '_'), used by the page.
  MessageId add(std::string id) {
    ids_.push_back(std::move(id));
    return MessageId{static_cast<int>(ids_.size()) - 1};
  }
  std::vector<std::string> take() { return std::move(ids_); }

 private:
  std::vector<std::string> ids_;
};

namespace detail {

// Single-producer, single-consumer ring of messages; no locks, no allocation.
class MessageRing {
 public:
  static constexpr std::size_t kSize = 256;
  bool push(const Message& m) {
    const std::size_t h = head_.load(std::memory_order_relaxed);
    const std::size_t next = (h + 1) % kSize;
    if (next == tail_.load(std::memory_order_acquire)) return false;  // full
    buf_[h] = m;
    head_.store(next, std::memory_order_release);
    return true;
  }
  bool pop(Message& m) {
    const std::size_t t = tail_.load(std::memory_order_relaxed);
    if (t == head_.load(std::memory_order_acquire)) return false;
    m = buf_[t];
    tail_.store((t + 1) % kSize, std::memory_order_release);
    return true;
  }

 private:
  std::array<Message, kSize> buf_{};
  std::atomic<std::size_t> head_{0}, tail_{0};
};

}  // namespace detail

}  // namespace sk
