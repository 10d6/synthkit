// sk::Json — a small, dependency-free JSON value used for patches, custom
// state and synth.json. Objects keep insertion order so saved files stay
// readable and diff cleanly. Not for use on the audio thread.
#pragma once

#include <array>
#include <cstddef>
#include <map>
#include <memory>
#include <stdexcept>
#include <string>
#include <string_view>
#include <type_traits>
#include <utility>
#include <vector>

namespace sk {

class Json {
 public:
  enum class Type { Null, Bool, Number, String, Array, Object };
  using Array = std::vector<Json>;
  using Member = std::pair<std::string, Json>;
  using Object = std::vector<Member>;

  Json() = default;
  Json(std::nullptr_t) {}
  Json(bool b) : type_(Type::Bool), num_(b ? 1 : 0) {}
  template <typename T, std::enable_if_t<std::is_arithmetic_v<T> && !std::is_same_v<T, bool>, int> = 0>
  Json(T v) : type_(Type::Number), num_(static_cast<double>(v)) {}
  Json(const char* s) : type_(Type::String), str_(s) {}
  Json(std::string s) : type_(Type::String), str_(std::move(s)) {}
  Json(std::string_view s) : type_(Type::String), str_(s) {}
  Json(Array a) : type_(Type::Array), arr_(std::move(a)) {}
  template <typename T, std::size_t N>
  Json(const std::array<T, N>& a) : type_(Type::Array) {
    for (auto& v : a) arr_.emplace_back(v);
  }
  template <typename T>
  Json(const std::vector<T>& v) : type_(Type::Array) {
    for (auto& x : v) arr_.emplace_back(x);
  }

  static Json array() { Json j; j.type_ = Type::Array; return j; }
  static Json object() { Json j; j.type_ = Type::Object; return j; }

  static Json parse(std::string_view text);  // throws sk::JsonError (or fails, without exceptions)
  // Never throws: false + message (with line:column) on bad input.
  static bool tryParse(std::string_view text, Json& out, std::string* error = nullptr);
  std::string dump(int indent = 2) const;

  Type type() const { return type_; }
  bool isNull() const { return type_ == Type::Null; }
  bool isBool() const { return type_ == Type::Bool; }
  bool isNumber() const { return type_ == Type::Number; }
  bool isString() const { return type_ == Type::String; }
  bool isArray() const { return type_ == Type::Array; }
  bool isObject() const { return type_ == Type::Object; }

  // Accessors with fallbacks: never throw on a type mismatch.
  double number(double fallback = 0) const { return isNumber() || isBool() ? num_ : fallback; }
  bool boolean(bool fallback = false) const { return isBool() || isNumber() ? num_ != 0 : fallback; }
  const std::string& string() const { static const std::string e; return isString() ? str_ : e; }
  std::string string(std::string fallback) const { return isString() ? str_ : fallback; }

  std::size_t size() const { return isArray() ? arr_.size() : isObject() ? obj_.size() : 0; }
  bool contains(std::string_view key) const;

  // Read access: missing keys / indices return a shared null.
  const Json& operator[](std::string_view key) const;
  const Json& operator[](std::size_t i) const;
  // Write access: converts null to object/array as needed.
  Json& operator[](std::string_view key);
  Json& operator[](std::size_t i);
  Json& operator[](int i) { return (*this)[static_cast<std::size_t>(i)]; }
  const Json& operator[](int i) const { return (*this)[static_cast<std::size_t>(i)]; }
  Json& operator[](const char* key) { return (*this)[std::string_view(key)]; }
  const Json& operator[](const char* key) const { return (*this)[std::string_view(key)]; }

  void push(Json v);
  bool erase(std::string_view key);
  const Array& items() const { static const Array e; return isArray() ? arr_ : e; }
  const Object& members() const { static const Object e; return isObject() ? obj_ : e; }

  // Copy a numeric array into a fixed-size container (extra/missing ignored).
  template <typename T, std::size_t N>
  void to(std::array<T, N>& out) const {
    for (std::size_t i = 0; i < N && i < size(); ++i) out[i] = static_cast<T>(arr_[i].number(out[i]));
  }
  template <typename T>
  void to(std::vector<T>& out) const {
    out.clear();
    for (auto& v : items()) out.push_back(static_cast<T>(v.number()));
  }

  bool operator==(const Json& o) const;
  bool operator!=(const Json& o) const { return !(*this == o); }

 private:
  void dumpTo(std::string& out, int indent, int depth) const;
  Type type_ = Type::Null;
  double num_ = 0;
  std::string str_;
  Array arr_;
  Object obj_;
};

struct JsonError : std::runtime_error {
  using std::runtime_error::runtime_error;
};

}  // namespace sk
