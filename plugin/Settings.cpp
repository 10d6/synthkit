#include "Settings.h"

#include <map>

namespace skplugin {

namespace {

juce::File settingsRoot() {
  auto base = juce::File::getSpecialLocation(juce::File::userApplicationDataDirectory);
#if JUCE_MAC
  base = base.getChildFile("Application Support");
#endif
  return base.getChildFile("synthkit");
}

}  // namespace

std::shared_ptr<Settings> Settings::forSynth(const juce::String& synthId) {
  JUCE_ASSERT_MESSAGE_THREAD
  static std::map<juce::String, std::weak_ptr<Settings>> open;
  auto& slot = open[synthId];
  if (auto s = slot.lock()) return s;
  auto safeId = juce::File::createLegalFileName(synthId.isEmpty() ? juce::String("synth") : synthId);
  std::shared_ptr<Settings> s(new Settings(settingsRoot().getChildFile(safeId).getChildFile("settings.json")));
  slot = s;
  return s;
}

Settings::Settings(juce::File file) : file_(std::move(file)) {
  juce::var parsed;
  if (file_.existsAsFile() && juce::JSON::parse(file_.loadFileAsString(), parsed).wasOk() && parsed.isObject())
    data_ = parsed;
  else
    data_ = juce::var(new juce::DynamicObject());
}

juce::var Settings::get(const juce::String& key) const {
  if (auto* o = data_.getDynamicObject()) return o->getProperty(key);
  return {};
}

void Settings::set(const juce::String& key, const juce::var& value, const void* source) {
  JUCE_ASSERT_MESSAGE_THREAD
  if (auto* o = data_.getDynamicObject()) o->setProperty(key, value);
  save();
  auto copy = listeners_;  // a listener may remove itself
  for (auto& l : copy)
    if (l.owner != source) l.fn(key, value);
}

int Settings::addListener(Listener fn, const void* owner) {
  listeners_.push_back({nextToken_, owner, std::move(fn)});
  return nextToken_++;
}

void Settings::removeListener(int token) {
  listeners_.erase(std::remove_if(listeners_.begin(), listeners_.end(), [token](const Entry& e) { return e.token == token; }),
                   listeners_.end());
}

void Settings::save() const {
  if (!file_.getParentDirectory().createDirectory()) return;
  // Write to a temporary file and swap it in, so a crash never leaves half a file.
  juce::TemporaryFile tmp(file_);
  if (tmp.getFile().replaceWithText(juce::JSON::toString(data_, true))) tmp.overwriteTargetFileWithTemporary();
}

}  // namespace skplugin
