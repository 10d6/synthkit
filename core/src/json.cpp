#include "synthkit/json.h"

#include "synthkit/error.h"

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
  bool bad = false;
  std::string error;
  int depth = 0;

  Json fail(const char* what) {
    if (bad) return Json();
    bad = true;
    // Report line:column for readable errors in hand-edited patches.
    std::size_t line = 1, col = 1;
    for (std::size_t k = 0; k < i && k < s.size(); ++k) {
      if (s[k] == '\n') { ++line; col = 1; } else { ++col; }
    }
    error = std::string("JSON: ") + what + " at " + std::to_string(line) + ":" + std::to_string(col);
    return Json();
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
    if (i >= s.size()) return fail("unexpected end");
    if (++depth > 200) return fail("nested too deeply");
    Json v;
    char c = s[i];
    if (c == '{') v = obj();
    else if (c == '[') v = arr();
    else if (c == '"') { std::string t; if (str(t)) v = Json(std::move(t)); }
    else if (lit("true")) v = Json(true);
    else if (lit("false")) v = Json(false);
    else if (lit("null")) v = Json();
    else if (c == '-' || (c >= '0' && c <= '9')) v = num();
    else return fail("unexpected character");
    --depth;
    return v;
  }

  Json obj() {
    Json o = Json::object();
    ++i;
    ws();
    if (i < s.size() && s[i] == '}') { ++i; return o; }
    while (!bad) {
      ws();
      if (i >= s.size() || s[i] != '"') return fail("expected key");
      std::string k;
      if (!str(k)) return Json();
      ws();
      if (i >= s.size() || s[i] != ':') return fail("expected ':'");
      ++i;
      Json v = value();
      if (bad) return Json();
      o[k] = std::move(v);
      ws();
      if (i < s.size() && s[i] == ',') { ++i; ws(); if (i < s.size() && s[i] == '}') { ++i; return o; } continue; }
      if (i < s.size() && s[i] == '}') { ++i; return o; }
      return fail("expected ',' or '}'");
    }
    return Json();
  }

  Json arr() {
    Json a = Json::array();
    ++i;
    ws();
    if (i < s.size() && s[i] == ']') { ++i; return a; }
    while (!bad) {
      Json v = value();
      if (bad) return Json();
      a.push(std::move(v));
      ws();
      if (i < s.size() && s[i] == ',') { ++i; ws(); if (i < s.size() && s[i] == ']') { ++i; return a; } continue; }
      if (i < s.size() && s[i] == ']') { ++i; return a; }
      return fail("expected ',' or ']'");
    }
    return Json();
  }

  static void utf8(std::string& out, unsigned cp) {
    if (cp < 0x80) out += char(cp);
    else if (cp < 0x800) { out += char(0xC0 | (cp >> 6)); out += char(0x80 | (cp & 0x3F)); }
    else if (cp < 0x10000) { out += char(0xE0 | (cp >> 12)); out += char(0x80 | ((cp >> 6) & 0x3F)); out += char(0x80 | (cp & 0x3F)); }
    else { out += char(0xF0 | (cp >> 18)); out += char(0x80 | ((cp >> 12) & 0x3F)); out += char(0x80 | ((cp >> 6) & 0x3F)); out += char(0x80 | (cp & 0x3F)); }
  }

  bool hex4(unsigned& v) {
    if (i + 4 > s.size()) { fail("bad \\u escape"); return false; }
    v = 0;
    for (int k = 0; k < 4; ++k) {
      char c = s[i++];
      v <<= 4;
      if (c >= '0' && c <= '9') v |= static_cast<unsigned>(c - '0');
      else if (c >= 'a' && c <= 'f') v |= static_cast<unsigned>(c - 'a' + 10);
      else if (c >= 'A' && c <= 'F') v |= static_cast<unsigned>(c - 'A' + 10);
      else { fail("bad \\u escape"); return false; }
    }
    return true;
  }

  bool str(std::string& out) {
    ++i;  // opening quote
    while (true) {
      if (i >= s.size()) { fail("unterminated string"); return false; }
      char c = s[i++];
      if (c == '"') return true;
      if (c != '\\') { out += c; continue; }
      if (i >= s.size()) { fail("unterminated string"); return false; }
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
          unsigned cp;
          if (!hex4(cp)) return false;
          if (cp >= 0xD800 && cp < 0xDC00 && i + 1 < s.size() && s[i] == '\\' && s[i + 1] == 'u') {
            i += 2;
            unsigned lo;
            if (!hex4(lo)) return false;
            cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
          }
          utf8(out, cp);
          break;
        }
        default: fail("bad escape"); return false;
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
    if (in.fail()) return fail("bad number");
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

bool Json::tryParse(std::string_view text, Json& out, std::string* error) {
  Parser p;
  p.s = text;
  Json v = p.value();
  if (!p.bad) {
    p.ws();
    if (p.i != text.size()) p.fail("trailing characters");
  }
  if (p.bad) {
    if (error) *error = p.error;
    return false;
  }
  out = std::move(v);
  return true;
}

Json Json::parse(std::string_view text) {
  Json out;
  std::string err;
  if (!tryParse(text, out, &err)) {
#if SK_HAS_EXCEPTIONS
    throw JsonError(err);
#else
    fail(err);
#endif
  }
  return out;
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
  if (type_ != Type::Object) ::sk::fail("JSON: not an object");
  for (auto& m : obj_) if (m.first == key) return m.second;
  obj_.emplace_back(std::string(key), Json());
  return obj_.back().second;
}

Json& Json::operator[](std::size_t i) {
  if (type_ == Type::Null) type_ = Type::Array;
  if (type_ != Type::Array) ::sk::fail("JSON: not an array");
  if (i >= arr_.size()) arr_.resize(i + 1);
  return arr_[i];
}

void Json::push(Json v) {
  if (type_ == Type::Null) type_ = Type::Array;
  if (type_ != Type::Array) ::sk::fail("JSON: not an array");
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
