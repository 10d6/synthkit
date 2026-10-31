#pragma once

#include <juce_audio_processors/juce_audio_processors.h>

namespace skplugin {

class Processor;

// The plugin window: the synth's browser page in a web view, wired to the
// processor instead of browser audio. Falls back to JUCE's generic parameter
// list when the build has no page (SYNTHKIT_WEB_UI_DIR unset).
juce::AudioProcessorEditor* makeEditor(Processor& p);

}  // namespace skplugin
