// Settings shared by every instance of a synth on this computer: your own
// presets, theme, keyboard octave and so on (what the browser keeps in local
// storage). One JSON file per synth:
//   Windows  %APPDATA%\synthkit\<id>\settings.json
//   macOS    ~/Library/Application Support/synthkit/<id>/settings.json
//   Linux    ~/.config/synthkit/<id>/settings.json
// Message thread only. Open editors are told when another one changes a key.
#pragma once

#include <juce_events/juce_events.h>

#include <functional>
#include <memory>

namespace skplugin {

class Settings {
 public:
  using Listener = std::function<void(const juce::String& key, const juce::var& value)>;

  // One per synth id, shared by all instances in the process.
  static std::shared_ptr<Settings> forSynth(const juce::String& synthId);

  juce::var all() const { return data_; }   // { key: value, … }
  juce::var get(const juce::String& key) const;
  void set(const juce::String& key, const juce::var& value, const void* source);

  // Returns a token for removeListener. `source` lets a listener skip its own writes.
  int addListener(Listener fn, const void* owner);
  void removeListener(int token);

  juce::File file() const { return file_; }

 private:
  explicit Settings(juce::File file);
  void save() const;

  juce::File file_;
  juce::var data_;
  struct Entry { int token; const void* owner; Listener fn; };
  std::vector<Entry> listeners_;
  int nextToken_ = 1;
};

}  // namespace skplugin
