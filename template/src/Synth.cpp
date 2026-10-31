// {{NAME}}. Start here: everything a synth can do is in synthkit/API.md.
// This starter is one oscillator into a filter, with the kit's amp envelope,
// LFO, mod matrix and voice modes.
#include <synthkit/synth.h>

using namespace sk;

struct {{CLASS}};

struct {{CLASS}}Voice : Voice {
  explicit {{CLASS}}Voice({{CLASS}}& s) : synth(s) {}

  void prepare(const PrepareInfo& info) override {
    osc.prepare(static_cast<float>(info.sampleRate));
    filter.prepare(static_cast<float>(info.sampleRate));
  }
  void start(const NoteOn& n, const StartInfo& s) override;
  void render(VoiceContext& ctx, Buffer& out) override;

  {{CLASS}}& synth;
  dsp::Osc osc;
  dsp::Svf filter;
};

struct {{CLASS}} : Synth {
  Param wave, cutoff, reso;

  void defineParams(ParamBuilder& b) override {
    wave = b.add("osc.wave").name("Wave").choices({"Saw", "Square", "Triangle", "Sine"}).group("Oscillator");
    cutoff = b.add("filter.cutoff").name("Cutoff").range(20, 20000).log().def(3000).unit("Hz").modulatable().group("Filter");
    reso = b.add("filter.reso").name("Resonance").range(0, 1).def(0.2).modulatable().group("Filter");
  }

  std::unique_ptr<Voice> makeVoice() override { return std::make_unique<{{CLASS}}Voice>(*this); }
};

void {{CLASS}}Voice::start(const NoteOn&, const StartInfo& s) {
  if (!s.sounding) {  // a fresh voice: start clean (a sounding one would click)
    osc.reset(0);
    filter.reset();
  }
}

void {{CLASS}}Voice::render(VoiceContext& ctx, Buffer& out) {
  static constexpr dsp::Osc::Wave waves[] = {dsp::Osc::Wave::Saw, dsp::Osc::Wave::Square, dsp::Osc::Wave::Triangle,
                                             dsp::Osc::Wave::Sine};
  osc.setWave(waves[ctx.choice(synth.wave)]);
  osc.setFreq(static_cast<float>(ctx.pitchHz()));
  filter.set(ctx.get(synth.cutoff), ctx.get(synth.reso));
  for (int i = 0; i < out.frames; ++i) out.add(i, 0.3f * filter.process(osc.next()));
}

SK_SYNTH({{CLASS}})
