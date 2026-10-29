#include "synthkit/json.h"

#include <cmath>
#include <cstdio>
#include <cstring>
#include <locale>
#include <sstream>

namespace sk {

namespace {

const Json& nullJson() {
  static const Json n;
  return n;
}

struct Parser {
  std::string_view s;
  std::size_t i = 0;

  [[noreturn]] void fail(const char* what) {
    // Report line:column for readable errors in hand-edited patches.
    std::size_t line = 1, col = 1;
    for (std::size_t k = 0; k < i && k < s.size(); ++k) {
      if (s[k] == '\n') { ++line; col = 1; } else { ++col; }
    }
    throw JsonError(std::string("JSON: ") + what + " at " + std::to_string(line) + ":" + std::to_string(col));
  }

  void ws() {
    while (i < s.size()) {
      char c = s[i];
      if (c == ' ' || c == '\t' || c == '\n' || c == '\r') { ++i; continue; }
      // Allow // line comments: handy in hand-written test scenarios.
      if (c == '/' && i + 1 < s.size() && s[i + 1] == '/') {
        while (i < s.size() && s[i] != '\n') ++i;
        continue;
      }
      break;
    }
  }

  bool lit(const char* w) {
    std::size_t n = std::strlen(w);
    if (s.substr(i, n) == w) { i += n; return true; }
    return false;
  }

  Json value() {
    ws();
    if (i >= s.size()) fail("unexpected end");
    char c = s[i];
    if (c == '{') return obj();
    if (c == '[') return arr();
    if (c == '"') return Json(str());
    if (lit("true")) return Json(true);
    if (lit("false")) return Json(false);
    if (lit("null")) return Json();
    if (c == '-' || (c >= '0' && c <= '9')) return num();
    fail("unexpected character");
  }

  Json obj() {
    Json o = Json::object();
    ++i;
    ws();
    if (i < s.size() && s[i] == '}') { ++i; return o; }
    while (true) {
      ws();
      if (i >= s.size() || s[i] != '"') fail("expected key");
      std::string k = str();
      ws();
      if (i >= s.size() || s[i] != ':') fail("expected ':'");
      ++i;
      o[k] = value();
      ws();
      if (i < s.size() && s[i] == ',') { ++i; ws(); if (i < s.size() && s[i] == '}') { ++i; return o; } continue; }
      if (i < s.size() && s[i] == '}') { ++i; return o; }
      fail("expected ',' or '}'");
    }
  }

  Json arr() {
    Json a = Json::array();
    ++i;
    ws();
    if (i < s.size() && s[i] == ']') { ++i; return a; }
    while (true) {
      a.push(value());
      ws();
      if (i < s.size() && s[i] == ',') { ++i; ws(); if (i < s.size() && s[i] == ']') { ++i; return a; } continue; }
      if (i < s.size() && s[i] == ']') { ++i; return a; }
      fail("expected ',' or ']'");
    }
  }

  static void utf8(std::string& out, unsigned cp) {
    if (cp < 0x80) out += char(cp);
    else if (cp < 0x800) { out += char(0xC0 | (cp >> 6)); out += char(0x80 | (cp & 0x3F)); }
    else if (cp < 0x10000) { out += char(0xE0 | (cp >> 12)); out += char(0x80 | ((cp >> 6) & 0x3F)); out += char(0x80 | (cp & 0x3F)); }
    else { out += char(0xF0 | (cp >> 18)); out += char(0x80 | ((cp >> 12) & 0x3F)); out += char(0x80 | ((cp >> 6) & 0x3F)); out += char(0x80 | (cp & 0x3F)); }
  }

  unsigned hex4() {
    if (i + 4 > s.size()) fail("bad \\u escape");
    unsigned v = 0;
    for (int k = 0; k < 4; ++k) {
      char c = s[i++];
      v <<= 4;
      if (c >= '0' && c <= '9') v |= c - '0';
      else if (c >= 'a' && c <= 'f') v |= c - 'a' + 10;
      else if (c >= 'A' && c <= 'F') v |= c - 'A' + 10;
      else fail("bad \\u escape");
    }
    return v;
  }

  std::string str() {
    std::string out;
    ++i;  // opening quote
    while (true) {
      if (i >= s.size()) fail("unterminated string");
      char c = s[i++];
      if (c == '"') return out;
      if (c != '\\') { out += c; continue; }
      if (i >= s.size()) fail("unterminated string");
      char e = s[i++];
      switch (e) {
        case '"': out += '"'; break;
        case '\\': out += '\\'; break;
        case '/': out += '/'; break;
        case 'b': out += '\b'; break;
        case 'f': out += '\f'; break;
        case 'n': out += '\n'; break;
        case 'r': out += '\r'; break;
        case 't': out += '\t'; break;
        case 'u': {
          unsigned cp = hex4();
          if (cp >= 0xD800 && cp < 0xDC00 && i + 1 < s.size() && s[i] == '\\' && s[i + 1] == 'u') {
            i += 2;
            unsigned lo = hex4();
            cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
          }
          utf8(out, cp);
          break;
        }
        default: fail("bad escape");
      }
    }
  }

  Json num() {
    std::size_t start = i;
    if (s[i] == '-') ++i;
    while (i < s.size() && ((s[i] >= '0' && s[i] <= '9') || s[i] == '.' || s[i] == 'e' || s[i] == 'E' ||
                            s[i] == '+' || s[i] == '-'))
      ++i;
    // Locale-independent: hosts sometimes set a locale with ',' decimals.
    std::istringstream in(std::string(s.substr(start, i - start)));
    in.imbue(std::locale::classic());
    double d;
    in >> d;
    if (in.fail()) fail("bad number");
    return Json(d);
  }
};

void escape(std::string& out, const std::string& v) {
  out += '"';
  for (unsigned char c : v) {
    switch (c) {
      case '"': out += "\\\""; break;
      case '\\': out += "\\\\"; break;
      case '\n': out += "\\n"; break;
      case '\r': out += "\\r"; break;
      case '\t': out += "\\t"; break;
      default:
        if (c < 0x20) {
          char buf[8];
          std::snprintf(buf, sizeof buf, "\\u%04x", c);
          out += buf;
        } else {
          out += char(c);
        }
    }
  }
  out += '"';
}

std::string formatNumber(double d) {
  if (!std::isfinite(d)) return "null";
  if (d == std::floor(d) && std::fabs(d) < 1e15) {
    std::ostringstream o;
    o.imbue(std::locale::classic());
    o << static_cast<long long>(d);
    return o.str();
  }
  // 7 significant digits: floats round-trip cleanly to what a user typed.
  std::ostringstream o;
  o.imbue(std::locale::classic());
  o.precision(7);
  o << d;
  return o.str();
}

}  // namespace

Json Json::parse(std::string_view text) {
  Parser p{text};
  Json v = p.value();
  p.ws();
  if (p.i != text.size()) p.fail("trailing characters");
  return v;
}

bool Json::contains(std::string_view key) const {
  if (!isObject()) return false;
  for (auto& m : obj_) if (m.first == key) return true;
  return false;
}

const Json& Json::operator[](std::string_view key) const {
  if (isObject()) for (auto& m : obj_) if (m.first == key) return m.second;
  return nullJson();
}

const Json& Json::operator[](std::size_t i) const {
  if (isArray() && i < arr_.size()) return arr_[i];
  return nullJson();
}

Json& Json::operator[](std::string_view key) {
  if (type_ == Type::Null) type_ = Type::Object;
  if (type_ != Type::Object) throw JsonError("JSON: not an object");
  for (auto& m : obj_) if (m.first == key) return m.second;
  obj_.emplace_back(std::string(key), Json());
  return obj_.back().second;
}

Json& Json::operator[](std::size_t i) {
  if (type_ == Type::Null) type_ = Type::Array;
  if (type_ != Type::Array) throw JsonError("JSON: not an array");
  if (i >= arr_.size()) arr_.resize(i + 1);
  return arr_[i];
}

void Json::push(Json v) {
  if (type_ == Type::Null) type_ = Type::Array;
  if (type_ != Type::Array) throw JsonError("JSON: not an array");
  arr_.push_back(std::move(v));
}

bool Json::erase(std::string_view key) {
  if (!isObject()) return false;
  for (auto it = obj_.begin(); it != obj_.end(); ++it)
    if (it->first == key) { obj_.erase(it); return true; }
  return false;
}

bool Json::operator==(const Json& o) const {
  if (type_ != o.type_) return false;
  switch (type_) {
    case Type::Null: return true;
    case Type::Bool:
    case Type::Number: return num_ == o.num_;
    case Type::String: return str_ == o.str_;
    case Type::Array: return arr_ == o.arr_;
    case Type::Object: {
      if (obj_.size() != o.obj_.size()) return false;
      for (auto& m : obj_) {
        if (!o.contains(m.first) || o[m.first] != m.second) return false;
      }
      return true;
    }
  }
  return false;
}

void Json::dumpTo(std::string& out, int indent, int depth) const {
  auto nl = [&](int d) {
    if (indent <= 0) return;
    out += '\n';
    out.append(static_cast<std::size_t>(indent * d), ' ');
  };
  switch (type_) {
    case Type::Null: out += "null"; break;
    case Type::Bool: out += num_ != 0 ? "true" : "false"; break;
    case Type::Number: out += formatNumber(num_); break;
    case Type::String: escape(out, str_); break;
    case Type::Array: {
      if (arr_.empty()) { out += "[]"; break; }
      // Arrays of plain numbers stay on one line (tables, curves).
      bool flat = true;
      for (auto& v : arr_) if (v.isArray() || v.isObject()) { flat = false; break; }
      out += '[';
      for (std::size_t k = 0; k < arr_.size(); ++k) {
        if (k) out += flat || indent <= 0 ? (indent > 0 ? ", " : ",") : ",";
        if (!flat) nl(depth + 1);
        arr_[k].dumpTo(out, indent, depth + 1);
      }
      if (!flat) nl(depth);
      out += ']';
      break;
    }
    case Type::Object: {
      if (obj_.empty()) { out += "{}"; break; }
      out += '{';
      for (std::size_t k = 0; k < obj_.size(); ++k) {
        if (k) out += ',';
        nl(depth + 1);
        escape(out, obj_[k].first);
        out += indent > 0 ? ": " : ":";
        obj_[k].second.dumpTo(out, indent, depth + 1);
      }
      nl(depth);
      out += '}';
      break;
    }
  }
}

std::string Json::dump(int indent) const {
  std::string out;
  dumpTo(out, indent, 0);
  return out;
}

}  // namespace sk
