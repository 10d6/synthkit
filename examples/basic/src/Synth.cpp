// synthkit Basic: a two-oscillator subtractive synth used to exercise the
// kit. Everything here goes through the public API only (API.md).
#include <synthkit/synth.h>

#include <cmath>

using namespace sk;

struct Basic;

struct BasicVoice : Voice {
  explicit BasicVoice(Basic& s) : synth(s) {}

  void prepare(const PrepareInfo& info) override {
    float sr = static_cast<float>(info.sampleRate);
    osc1.prepare(sr);
    osc2.prepare(sr);
    sub.prepare(sr);
    ladder.prepare(sr);
    svf.prepare(sr);
  }

  void start(const NoteOn& n, const StartInfo& s) override;
  void render(VoiceContext& ctx, Buffer& out) override;

  Basic& synth;
  dsp::Osc osc1, osc2, sub;
  dsp::Noise noise;
  dsp::Ladder ladder;
  dsp::Svf svf;
  float drift = 0, driftTarget = 0;
  int driftClock = 0;
};

struct Basic : Synth {
  Param wave1, pw1, wave2, semi2, fine2, level2, subLevel, noiseLevel, drift;
  Param filterType, cutoff, reso, drive, keytrack, envAmount, filterVel;
  Param delayMix, delayTime, delayFeedback, delayTone;

  void defineParams(ParamBuilder& b) override {
    const std::vector<std::string> waves = {"Saw", "Square", "Triangle", "Sine"};
    wave1 = b.add("osc1.wave").name("Osc 1 Wave").choices(waves).group("Oscillators");
    pw1 = b.add("osc1.pw").name("Osc 1 Pulse Width").range(0.05, 0.95).def(0.5).modulatable().group("Oscillators");
    wave2 = b.add("osc2.wave").name("Osc 2 Wave").choices(waves).group("Oscillators");
    semi2 = b.add("osc2.semi").name("Osc 2 Semitones").range(-24, 24).integer().def(0).unit("st").group("Oscillators");
    fine2 = b.add("osc2.fine").name("Osc 2 Fine").range(-50, 50).def(7).unit("ct").group("Oscillators");
    level2 = b.add("osc2.level").name("Osc 2 Level").range(0, 1).def(0.5).modulatable().group("Oscillators");
    subLevel = b.add("sub.level").name("Sub Level").range(0, 1).def(0).modulatable().group("Oscillators");
    noiseLevel = b.add("noise.level").name("Noise").range(0, 1).def(0).modulatable().group("Oscillators");
    drift = b.add("drift").name("Drift").range(0, 1).def(0.2).group("Oscillators");

    filterType = b.add("filter.type").name("Filter Type").choices({"Ladder", "SVF Low", "SVF High", "SVF Band"}).group("Filter");
    cutoff = b.add("filter.cutoff").name("Cutoff").range(20, 20000).log().def(2400).unit("Hz").modulatable().group("Filter");
    reso = b.add("filter.reso").name("Resonance").range(0, 1).def(0.25).modulatable().group("Filter");
    drive = b.add("filter.drive").name("Drive").range(0, 24).def(0).unit("dB").modulatable().group("Filter");
    keytrack = b.add("filter.keytrack").name("Key Track").range(0, 1).def(0.5).group("Filter");
    envAmount = b.add("filter.env").name("Env Amount").range(-1, 1).def(0.35).modulatable().group("Filter");
    filterVel = b.add("filter.velocity").name("Velocity").range(0, 1).def(0.3).group("Filter");

    delayMix = b.add("delay.mix").name("Delay Mix").range(0, 1).def(0.15).modulatable().group("Delay");
    delayTime = b.add("delay.time").name("Delay Time").choices({"1/4", "1/8.", "1/8", "1/8T", "1/16"}).def(1).group("Delay");
    delayFeedback = b.add("delay.feedback").name("Feedback").range(0, 0.9).def(0.35).group("Delay");
    delayTone = b.add("delay.tone").name("Delay Tone").range(500, 16000).log().def(4000).unit("Hz").group("Delay");
  }

  std::unique_ptr<Voice> makeVoice() override { return std::make_unique<BasicVoice>(*this); }

  // ---- messages (API.md §9b): the page's "Clear echoes" button empties the
  // delay, and the engine answers so the button can show it happened.
  MessageId clearDelay, delayCleared;
  bool clearPending = false;

  void defineMessages(MessageBuilder& b) override {
    clearDelay = b.add("delay.clear");
    delayCleared = b.add("delay.cleared");
  }

  void processEvents(EventContext& ctx) override {
    for (auto& m : ctx.messages())
      if (m.is(clearDelay)) clearPending = true;
    for (auto& e : ctx.in()) ctx.out(e);
  }

  // ---- global: tempo-synced stereo delay
  dsp::Delay dl, dr;
  dsp::OnePole tl, tr, dcl, dcr;
  dsp::Smoother time;
  float sr = 48000;

  void prepare(const PrepareInfo& info) override {
    sr = static_cast<float>(info.sampleRate);
    dl.prepare(sr, 2.5f);
    dr.prepare(sr, 2.5f);
    tl.prepare(sr); tr.prepare(sr);
    dcl.prepare(sr); dcr.prepare(sr);
    dcl.set(15); dcr.set(15);
    time.prepare(sr, 60);
    time.reset(0.25f * sr);
  }

  void processGlobal(GlobalContext& ctx, Buffer& io) override {
    static const Division divs[] = {Division::Quarter, Division::Eighth.dotted(), Division::Eighth,
                                    Division::Eighth.triplet(), Division::Sixteenth};
    float mix = ctx.get(delayMix);
    float fb = ctx.get(delayFeedback);
    tl.set(ctx.get(delayTone));
    tr.set(ctx.get(delayTone));
    if (clearPending) {
      clearPending = false;
      dl.reset();
      dr.reset();
      tl.reset(); tr.reset(); dcl.reset(); dcr.reset();   // their memory would echo too
      ctx.post(delayCleared, {static_cast<float>(ctx.transport().beat)});
    }
    double beats = divs[ctx.choice(delayTime)].length(ctx.transport());
    time.setTarget(static_cast<float>(std::min(2.4, beats * ctx.transport().secondsPerBeat()) * sr));
    for (int i = 0; i < io.frames; ++i) {
      float t = time.next();
      float l = io.left[i], r = io.right[i];
      // Ping-pong: left echo feeds right and vice versa.
      float el = dl.read(t), er = dr.read(t);
      dl.write(dcl.highpass(tl.lowpass(l + er * fb)));
      dr.write(dcr.highpass(tr.lowpass(r * 0.3f + el * fb)));
      io.left[i] = l + el * mix;
      io.right[i] = r + er * mix;
    }
  }
};

void BasicVoice::start(const NoteOn&, const StartInfo& s) {
  // Only a fresh voice gets new phases; resetting one that's still sounding
  // (mono retrigger, legato, steal) would click.
  if (s.sounding) return;
  // Random start phases, so unison layers and chords don't phase-cancel.
  osc1.reset(rng().uniform());
  osc2.reset(rng().uniform());
  sub.reset(rng().uniform());
  noise.seed(rng().next());
  ladder.reset();
  svf.reset();
}

void BasicVoice::render(VoiceContext& ctx, Buffer& out) {
  auto& s = synth;
  using W = dsp::Osc::Wave;
  static const W waves[] = {W::Saw, W::Square, W::Triangle, W::Sine};
  osc1.setWave(waves[ctx.choice(s.wave1)]);
  osc2.setWave(waves[ctx.choice(s.wave2)]);
  sub.setWave(W::Square);
  osc1.setPulseWidth(ctx.get(s.pw1));

  // Slow random pitch drift, a few cents, different for every voice. Steps on
  // the voice's own sample clock so it doesn't depend on host block size.
  driftClock += out.frames;
  while (driftClock >= 256) {
    driftClock -= 256;
    if (ctx.rng().chance(0.1f)) driftTarget = ctx.rng().bipolar();
  }
  drift += (driftTarget - drift) * (1.f - std::pow(0.9997f, static_cast<float>(out.frames)));
  double cents = drift * ctx.get(s.drift) * 12.0;

  float base = ctx.pitchHz() * std::exp2(static_cast<float>(cents / 1200.0));
  osc1.setFreq(base);
  osc2.setFreq(base * std::exp2((ctx.get(s.semi2) + ctx.get(s.fine2) / 100.f) / 12.f));
  sub.setFreq(base * 0.5f);

  float l2 = ctx.get(s.level2), ls = ctx.get(s.subLevel), ln = ctx.get(s.noiseLevel);
  int type = ctx.choice(s.filterType);
  float res = ctx.get(s.reso);
  float driveGain = dsp::dbToGain(ctx.get(s.drive));
  if (type > 0) {
    svf.setMode(type == 1 ? dsp::Svf::Mode::LowPass : type == 2 ? dsp::Svf::Mode::HighPass : dsp::Svf::Mode::BandPass);
  }

  // Cutoff in octaves: base + key tracking + envelope (±6 octaves) scaled by velocity.
  float octBase = std::log2(ctx.get(s.cutoff));
  float octKey = (static_cast<float>(ctx.pitch()) - 60.f) / 12.f * ctx.get(s.keytrack);
  float velAmt = ctx.get(s.filterVel);
  float envDepth = ctx.get(s.envAmount) * 6.f * (1.f - velAmt + velAmt * ctx.velocity());
  const float* env2 = ctx.envSamples(2);

  for (int i = 0; i < out.frames; ++i) {
    float x = osc1.next() + l2 * osc2.next() + ls * sub.next() + ln * noise.white();
    x *= 0.25f;
    float fc = std::exp2(octBase + octKey + envDepth * env2[i]);
    float y;
    if (type == 0) {
      ladder.set(fc, res, driveGain);
      y = ladder.process(x);
    } else {
      svf.set(fc, res);
      y = svf.process(dsp::softclip(x * driveGain));
    }
    out.add(i, y);
  }
}

SK_SYNTH(Basic)
