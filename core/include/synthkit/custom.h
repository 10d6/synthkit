// Custom state: synth-specific data that isn't a parameter (tables,
// sequences, maps). Saved in patches under "custom.<id>". The audio thread
// reads it lock-free; writes build a new copy and swap it in whole.
#pragma once

#include <atomic>
#include <cstdint>
#include <functional>
#include <memory>
#include <string>
#include <utility>
#include <vector>

#include "synthkit/error.h"
#include "synthkit/json.h"

#if !SK_SINGLE_THREADED
#include <mutex>
#endif

namespace sk {

namespace detail {
#if SK_SINGLE_THREADED
struct Mutex { void lock() {} void unlock() {} };
struct Lock { explicit Lock(Mutex&) {} };
#else
using Mutex = std::mutex;
using Lock = std::lock_guard<std::mutex>;
#endif
}  // namespace detail

// Shared between the engine and its custom slots so old copies are only freed
// once the audio thread can no longer be reading them.
struct AudioEpoch {
  std::atomic<uint64_t> blocks{0};   // incremented at the start of each block
  std::atomic<bool> running{false};  // true between prepare and release
};

class CustomSlotBase {
 public:
  explicit CustomSlotBase(std::string id) : id_(std::move(id)) {}
  virtual ~CustomSlotBase() = default;
  const std::string& id() const { return id_; }
  virtual Json save() const = 0;           // not audio thread
  virtual void load(const Json& j) = 0;    // not audio thread; null -> initial
  virtual void collect() = 0;              // free retired copies when safe
  uint32_t generation() const { return generation_.load(std::memory_order_relaxed); }

 protected:
  std::string id_;
  std::atomic<uint32_t> generation_{0};
};

template <typename T>
struct CustomIO {
  std::function<void(const T&, Json&)> save;
  std::function<void(const Json&, T&)> load;
  T initial{};
};

template <typename T>
class CustomSlot final : public CustomSlotBase {
 public:
  CustomSlot(std::string id, CustomIO<T> io, AudioEpoch* epoch)
      : CustomSlotBase(std::move(id)), io_(std::move(io)), epoch_(epoch) {
    current_.store(new T(io_.initial), std::memory_order_release);
  }
  ~CustomSlot() override {
    delete current_.load();
    for (auto& r : retired_) delete r.first;
  }

  const T& read() const { return *current_.load(std::memory_order_acquire); }

  void write(T value) {
    T* fresh = new T(std::move(value));
    T* old = current_.exchange(fresh, std::memory_order_acq_rel);
    detail::Lock lock(mutex_);
    retired_.emplace_back(old, epoch_ ? epoch_->blocks.load() : 0);
    generation_.fetch_add(1, std::memory_order_relaxed);
    collectLocked();
  }

  Json save() const override {
    Json j = Json::object();
    if (io_.save) io_.save(read(), j);
    return j;
  }

  void load(const Json& j) override {
    T fresh = io_.initial;
    if (!j.isNull() && io_.load) io_.load(j, fresh);
    write(std::move(fresh));
  }

  void collect() override {
    detail::Lock lock(mutex_);
    collectLocked();
  }

 private:
  void collectLocked() {
    // A copy retired at block count e is unreachable once block e+1 began
    // (one audio thread), or whenever audio isn't running at all.
    uint64_t now = epoch_ ? epoch_->blocks.load() : 0;
    bool running = epoch_ && epoch_->running.load();
    auto it = retired_.begin();
    while (it != retired_.end()) {
      if (!running || now > it->second) { delete it->first; it = retired_.erase(it); }
      else ++it;
    }
  }

  CustomIO<T> io_;
  AudioEpoch* epoch_;
  std::atomic<T*> current_{nullptr};
  detail::Mutex mutex_;
  std::vector<std::pair<T*, uint64_t>> retired_;
};

// Handle stored as a synth member.
template <typename T>
class Custom {
 public:
  Custom() = default;
  const T& read() const { return slot_->read(); }      // audio-thread safe
  void write(T v) { slot_->write(std::move(v)); }        // not audio thread
  template <typename F> void modify(F f) {               // not audio thread
    T copy = slot_->read();
    f(copy);
    slot_->write(std::move(copy));
  }
  bool valid() const { return slot_ != nullptr; }

 private:
  friend class CustomBuilder;
  explicit Custom(CustomSlot<T>* s) : slot_(s) {}
  CustomSlot<T>* slot_ = nullptr;
};

class CustomBuilder {
 public:
  explicit CustomBuilder(AudioEpoch* epoch) : epoch_(epoch) {}
  template <typename T>
  Custom<T> add(std::string id, CustomIO<T> io) {
    auto slot = std::make_unique<CustomSlot<T>>(std::move(id), std::move(io), epoch_);
    auto* raw = slot.get();
    slots_.push_back(std::move(slot));
    return Custom<T>(raw);
  }
  std::vector<std::unique_ptr<CustomSlotBase>> take() { return std::move(slots_); }

 private:
  AudioEpoch* epoch_;
  std::vector<std::unique_ptr<CustomSlotBase>> slots_;
};

}  // namespace sk
