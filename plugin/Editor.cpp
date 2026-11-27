#include "Editor.h"

#include "Processor.h"
#include "Settings.h"

#include <juce_gui_extra/juce_gui_extra.h>

#include <cmath>
#include <optional>

#if SK_PLUGIN_HAS_UI
#include "SkPluginUi.h"
#endif

namespace skplugin {

#if SK_PLUGIN_HAS_UI

namespace {

// Messages between the page and the plugin all use one event id; the payload
// is {t: kind, …}, mirroring what the page sends its browser audio worklet.
const juce::Identifier kEvent{"sk"};
const juce::String kSizeKey{"synthkit:plugin:size"};

sk::Json toSk(const juce::var& v) {
  sk::Json j;
  sk::Json::tryParse(juce::JSON::toString(v, true).toStdString(), j);
  return j;
}
sk::Json toSk(const juce::String& text) {
  sk::Json j;
  sk::Json::tryParse(text.toStdString(), j);
  return j;
}
juce::var toJuce(const sk::Json& j) { return juce::JSON::parse(juce::String::fromUTF8(j.dump(0).c_str())); }

juce::var finiteOrNull(float v) { return std::isfinite(v) ? juce::var(v) : juce::var(); }

juce::String wrapperName(juce::AudioProcessor::WrapperType t) {
  switch (t) {
    case juce::AudioProcessor::wrapperType_VST3: return "VST3";
    case juce::AudioProcessor::wrapperType_AudioUnit: return "AU";
    case juce::AudioProcessor::wrapperType_Standalone: return "Standalone";
    default: return "plugin";
  }
}

const char* findPage(int& size) {
  // The build embeds exactly one page (<name>.html).
  for (int i = 0; i < SkPluginUi::namedResourceListSize; ++i) {
    if (juce::String(SkPluginUi::originalFilenames[i]).endsWithIgnoreCase(".html"))
      return SkPluginUi::getNamedResource(SkPluginUi::namedResourceList[i], size);
  }
  size = 0;
  return nullptr;
}

}  // namespace

class WebEditor : public juce::AudioProcessorEditor, private juce::Timer {
 public:
  explicit WebEditor(Processor& p)
      : AudioProcessorEditor(p),
        proc_(p),
        settings_(Settings::forSynth(juce::String::fromUTF8(p.engine().info().id.c_str()))),
        web_(options()) {
    addAndMakeVisible(web_);
    // Changes after this point reach the page through the timer. (The page is
    // served a moment later with the state as it is then; a change in between
    // is sent twice, which is harmless.)
    for (auto* prm : proc_.params()) lastValues_.push_back(proc_.engine(prm->part()).params().get(prm->index()));
    for (int part = 0; part < proc_.partCount(); ++part) lastGenerations_.push_back(proc_.engine(part).params().generation());
    lastSerial_ = proc_.stateSerial();
    lastLayoutSerial_ = proc_.layoutSerial();
    // Messages posted while no window was open are stale.
    for (int part = 0; part < proc_.partCount(); ++part)
      for (sk::Message stale; proc_.engine(part).takeMessage(stale);) {}
    settingsToken_ = settings_->addListener(
        [this](const juce::String& key, const juce::var& value) { send(obj({{"t", "store"}, {"key", key}, {"value", value}})); },
        this);

    int w = 1240, h = 820;
    auto size = settings_->get(kSizeKey);
    if (size.isArray() && size.size() == 2) {
      w = juce::jlimit(560, 4000, static_cast<int>(size[0]));
      h = juce::jlimit(400, 3000, static_cast<int>(size[1]));
    }
    setResizable(true, true);
    setResizeLimits(560, 400, 4000, 3000);
    setSize(w, h);

    web_.goToURL(juce::WebBrowserComponent::getResourceProviderRoot());
    startTimerHz(30);
  }

  ~WebEditor() override {
    settings_->removeListener(settingsToken_);
    for (int part = 0; part < proc_.partCount(); ++part)
      for (int i = 0; i < proc_.paramsPerPart(); ++i) proc_.gesture(part, i, false);
  }

  void resized() override {
    web_.setBounds(getLocalBounds());
    sizeChangedAt_ = juce::Time::getMillisecondCounter();
  }

 private:
  using Props = std::initializer_list<std::pair<const char*, juce::var>>;
  static juce::var obj(Props props) {
    auto* o = new juce::DynamicObject();
    for (auto& [k, v] : props) o->setProperty(k, v);
    return juce::var(o);
  }

  juce::WebBrowserComponent::Options options() {
    using O = juce::WebBrowserComponent::Options;
    auto dataDir = settings_->file().getParentDirectory();
    return O{}
        .withBackend(O::Backend::webview2)
        .withWinWebView2Options(O::WinWebView2{}
                                    .withUserDataFolder(dataDir.getChildFile("webview2"))
                                    .withBackgroundColour(juce::Colour(0xffdcdfd9))
                                    .withStatusBarDisabled())
        .withNativeIntegrationEnabled()
        .withKeepPageLoadedWhenBrowserIsHidden()
        .withEventListener(kEvent, [this](const juce::var& m) { receive(m); })
        .withResourceProvider([this](const juce::String& url) { return resource(url); });
  }

  // The page, with the plugin's current state and settings injected so it
  // starts up showing this instance's sound.
  std::optional<juce::WebBrowserComponent::Resource> resource(const juce::String& url) {
    if (url != "/" && url != "/index.html") return std::nullopt;
    int size = 0;
    const char* page = findPage(size);
    if (page == nullptr) return std::nullopt;

    auto host = obj({{"format", wrapperName(proc_.wrapperType)},
                     {"host", juce::PluginHostType().getHostDescription()},
                     {"state", stateMessage("")},
                     {"store", settings_->all()}});
    // ASCII only, like the rest of the page (see web/pack.py).
    auto json = juce::JSON::toString(host, juce::JSON::FormatOptions{}
                                               .withSpacing(juce::JSON::Spacing::none)
                                               .withEncoding(juce::JSON::Encoding::ascii))
                    .replace("</", "<\\/");
    auto inject = "<script>window.__skHost = " + json + ";</script>\n";
    auto html = juce::String::fromUTF8(page, size);
    const int at = html.indexOf("<body>");
    html = at >= 0 ? html.substring(0, at + 6) + "\n" + inject + html.substring(at + 6) : inject + html;

    juce::WebBrowserComponent::Resource r;
    auto utf8 = html.toUTF8();
    const auto bytes = std::strlen(utf8.getAddress());
    r.data.resize(bytes);
    std::memcpy(r.data.data(), utf8.getAddress(), bytes);
    r.mimeType = "text/html; charset=utf-8";
    return r;
  }

  void send(const juce::var& msg) { web_.emitEventIfBrowserIsVisible(kEvent, msg); }

  // The sound as the page loads it: the patch, or for a multi the whole multi.
  // `t` names the message ("state"), or is empty for the page's initial state.
  juce::var stateMessage(const char* t) {
    juce::var m = obj({{"ui", proc_.uiState()}});
    auto* o = m.getDynamicObject();
    if (*t) o->setProperty("t", t);
    if (proc_.isMulti()) {
      o->setProperty("multi", toJuce(proc_.multiJson()));
    } else {
      std::lock_guard<std::mutex> g(proc_.engineLock());
      o->setProperty("patch", toJuce(proc_.engine().savePatch()));
    }
    return m;
  }

  int partOf(const juce::var& m) const { return juce::jlimit(0, proc_.partCount() - 1, m.hasProperty("p") ? static_cast<int>(m["p"]) : 0); }

  // From the page ---------------------------------------------------------------
  void receive(const juce::var& m) {
    const auto t = m["t"].toString();
    const int part = partOf(m);
    auto& engine = proc_.engine(part);
    if (t == "midi") {
      const auto& d = m["d"];
      if (d.isArray() && d.size() >= 1)
        proc_.queueUiMidi(static_cast<uint8_t>(static_cast<int>(d[0])), static_cast<uint8_t>(d.size() > 1 ? static_cast<int>(d[1]) : 0),
                          static_cast<uint8_t>(d.size() > 2 ? static_cast<int>(d[2]) : 0));
    } else if (t == "param") {
      const int i = m["i"];
      proc_.setParamFromUi(part, i, static_cast<double>(m["v"]));
      if (i >= 0 && i < proc_.paramsPerPart()) lastValues_[proc_.slot(part, i)] = engine.params().get(i);
    } else if (t == "gesture") {
      proc_.gesture(part, m["i"], static_cast<bool>(m["on"]));
    } else if (t == "select") {
      selected_ = part;
    } else if (t == "name") {
      // A voice renamed in the rack: the patch's name, saved with the project.
      std::lock_guard<std::mutex> g(proc_.engineLock());
      engine.patchMeta().name = m["name"].toString().toStdString();
    } else if (t == "patch") {
      auto r = proc_.loadPatchFromUi(part, toSk(m["json"].toString()));
      if (!r.ok) send(obj({{"t", "log"}, {"msg", juce::String::fromUTF8(r.error.c_str())}}));
      resyncBaseline();
    } else if (t == "layout") {
      proc_.setLayoutFromUi(toSk(m["json"].toString()));
    } else if (t == "multi") {
      auto r = proc_.loadMultiFromUi(toSk(m["json"].toString()));
      if (!r.ok) send(obj({{"t", "log"}, {"msg", juce::String::fromUTF8(r.error.c_str())}}));
      resyncBaseline();
    } else if (t == "custom") {
      std::lock_guard<std::mutex> g(proc_.engineLock());
      engine.setCustomState(m["id"].toString().toStdString(), toSk(m["json"].toString()));
    } else if (t == "mod") {
      std::lock_guard<std::mutex> g(proc_.engineLock());
      engine.setModMatrix(toSk(m["json"].toString()));
    } else if (t == "shapes") {
      std::lock_guard<std::mutex> g(proc_.engineLock());
      engine.setShapes(toSk(m["json"].toString()));
    } else if (t == "msg") {
      // A message for the synth (API.md §9b): lock-free, from this thread only.
      const int i = m["i"];
      float v[sk::Message::kMaxValues] = {};
      int n = 0;
      if (const auto* arr = m["v"].getArray())
        for (const auto& x : *arr) if (n < sk::Message::kMaxValues) v[n++] = static_cast<float>(static_cast<double>(x));
      engine.sendMessage(i, v, n);
    } else if (t == "panic") {
      if (proc_.isMulti()) proc_.multi()->panic();
      else engine.panic();
    } else if (t == "allOff") {
      if (proc_.isMulti()) proc_.multi()->allNotesOff();
      else engine.allNotesOff();
    } else if (t == "store") {
      settings_->set(m["key"].toString(), m["value"], this);
    } else if (t == "meta") {
      proc_.setUiState(m["ui"]);
    } else if (t == "export") {
      exportPreset(m["name"].toString(), m["json"].toString(), m["kind"].toString());
    } else if (t == "import") {
      importPreset(m["kind"].toString());
    } else if (t == "diag") {
      // Diagnostics (API.md §10a): the engine's recent events and counts
      // (lock-free reads), and where it runs.
      sk::Json d;
      if (proc_.isMulti()) {
        d = proc_.multi()->diagnostics();
      } else {
        sk::Json e = proc_.engine().diagnostics();
        e["part"] = 1;
        sk::Json parts = sk::Json::array();
        parts.push(std::move(e));
        d = sk::Json::object();
        d["parts"] = std::move(parts);
      }
      sk::Json host = sk::Json::object();
      host["format"] = wrapperName(proc_.wrapperType).toStdString();
      host["host"] = juce::String(juce::PluginHostType().getHostDescription()).toStdString();
      host["sampleRate"] = proc_.getSampleRate();
      host["blockSize"] = proc_.getBlockSize();
      d["plugin"] = std::move(host);
      send(obj({{"t", "diag"}, {"id", m["id"]}, {"json", juce::String::fromUTF8(d.dump(0).c_str())}}));
    } else if (t == "clipboard") {
      // The page's own clipboard may be closed to it in a plugin window.
      juce::SystemClipboard::copyTextToClipboard(m["text"].toString());
    }
  }

  void resyncBaseline() {
    for (auto* prm : proc_.params()) lastValues_[proc_.slot(prm->part(), prm->index())] = proc_.engine(prm->part()).params().get(prm->index());
    for (int part = 0; part < proc_.partCount(); ++part) lastGenerations_[static_cast<std::size_t>(part)] = proc_.engine(part).params().generation();
  }

  // Files ------------------------------------------------------------------------
  // kind: "multi" for a whole multi, else a patch.
  void exportPreset(const juce::String& name, const juce::String& json, const juce::String& kind) {
    const bool isMultiFile = kind == "multi";
    auto safe = juce::File::createLegalFileName(name.isEmpty() ? juce::String(isMultiFile ? "multi" : "patch") : name);
    chooser_ = std::make_unique<juce::FileChooser>(isMultiFile ? "Export multi" : "Export preset",
                                                   lastDir().getChildFile(safe + (isMultiFile ? ".multi.json" : ".json")), "*.json");
    chooser_->launchAsync(juce::FileBrowserComponent::saveMode | juce::FileBrowserComponent::canSelectFiles |
                              juce::FileBrowserComponent::warnAboutOverwriting,
                          [this, json](const juce::FileChooser& fc) {
                            auto f = fc.getResult();
                            if (f == juce::File()) return;
                            if (!f.hasFileExtension("json")) f = f.withFileExtension("json");
                            settings_->set("synthkit:plugin:lastDir", f.getParentDirectory().getFullPathName(), nullptr);
                            const bool ok = f.replaceWithText(json + "\n");
                            send(obj({{"t", "log"}, {"msg", ok ? "Saved " + f.getFileName() : "Couldn't write " + f.getFullPathName()},
                                      {"kind", ok ? "info" : "error"}}));
                          });
  }

  void importPreset(const juce::String& kind) {
    chooser_ = std::make_unique<juce::FileChooser>(kind == "multi" ? "Import multi" : "Import preset", lastDir(), "*.json");
    chooser_->launchAsync(juce::FileBrowserComponent::openMode | juce::FileBrowserComponent::canSelectFiles,
                          [this, kind](const juce::FileChooser& fc) {
                            auto f = fc.getResult();
                            if (!f.existsAsFile()) return;
                            settings_->set("synthkit:plugin:lastDir", f.getParentDirectory().getFullPathName(), nullptr);
                            send(obj({{"t", "imported"}, {"kind", kind}, {"file", f.getFileName()}, {"text", f.loadFileAsString()}}));
                          });
  }

  juce::File lastDir() const {
    juce::File d(settings_->get("synthkit:plugin:lastDir").toString());
    return d.isDirectory() ? d : juce::File::getSpecialLocation(juce::File::userDocumentsDirectory);
  }

  // To the page, 30 times a second ---------------------------------------------------
  void timerCallback() override {
    // The host loaded a project or preset: reload the page's copy.
    if (proc_.stateSerial() != lastSerial_) {
      lastSerial_ = proc_.stateSerial();
      lastLayoutSerial_ = proc_.layoutSerial();
      send(stateMessage("state"));
      resyncBaseline();
    }
    // The host moved a part's mute or solo.
    if (proc_.layoutSerial() != lastLayoutSerial_) {
      lastLayoutSerial_ = proc_.layoutSerial();
      send(obj({{"t", "layout"}, {"json", toJuce(proc_.layoutJson())}}));
    }
    // Automation and host edits.
    juce::Array<juce::var> changes;
    for (int part = 0; part < proc_.partCount(); ++part) {
      auto& engine = proc_.engine(part);
      auto& gen = lastGenerations_[static_cast<std::size_t>(part)];
      if (engine.params().generation() == gen) continue;
      gen = engine.params().generation();
      for (int i = 0; i < proc_.paramsPerPart(); ++i) {
        const auto k = proc_.slot(part, i);
        const float v = engine.params().get(i);
        if (v != lastValues_[k]) {
          lastValues_[k] = v;
          changes.add(juce::Array<juce::var>{i, v, part});
        }
      }
    }
    if (!changes.isEmpty()) send(obj({{"t", "params"}, {"changes", changes}}));
    sendMeters();
    sendMessages();

    // Remember the window size once resizing settles.
    if (sizeChangedAt_ && juce::Time::getMillisecondCounter() - sizeChangedAt_ > 600) {
      sizeChangedAt_ = 0;
      settings_->set(kSizeKey, juce::Array<juce::var>{getWidth(), getHeight()}, this);
    }
  }

  // Messages the synth posted (API.md §9b).
  void sendMessages() {
    juce::Array<juce::var> list;
    sk::Message msg;
    // Every part's queue is emptied; the page hears the selected part's, as
    // its own audio worklet would (it runs the selected part's page state).
    for (int part = 0; part < proc_.partCount(); ++part)
      while (proc_.engine(part).takeMessage(msg)) {
        if (part != selected_) continue;
        juce::Array<juce::var> v;
        for (int i = 0; i < msg.count; ++i) v.add(msg.values[static_cast<std::size_t>(i)]);
        list.add(juce::Array<juce::var>{msg.id.index, v});
      }
    if (!list.isEmpty()) send(obj({{"t", "msgs"}, {"list", list}}));
  }

  void sendMeters() {
    auto& engine = proc_.engine(selected_);
    const auto mtr = proc_.meters();
    float scope[Processor::kScopeSize];
    proc_.readScope(scope, Processor::kScopeSize);
    juce::Array<juce::var> sc;
    sc.ensureStorageAllocated(Processor::kScopeSize);
    for (float s : scope) sc.add(std::round(s * 10000.f) / 10000.f);

    const auto nSrc = engine.modSources().size();
    const auto nPar = static_cast<std::size_t>(engine.params().size());
    const auto nShp = static_cast<std::size_t>(engine.shapeCount()) * 2;
    modBuf_.resize(nSrc + nPar + nShp);
    engine.readModMeters(modBuf_.data(), modBuf_.data() + nSrc, modBuf_.data() + nSrc + nPar);
    juce::Array<juce::var> mod;
    mod.ensureStorageAllocated(static_cast<int>(modBuf_.size()));
    for (float v : modBuf_) mod.add(finiteOrNull(v));

    send(obj({{"t", "meter"},
              {"voices", mtr.voices},
              {"limiterDb", mtr.limiterDb},
              {"peak", mtr.peak},
              {"beat", mtr.beat},
              {"playing", mtr.playing},
              {"bpm", mtr.bpm},
              {"num", mtr.num},
              {"den", mtr.den},
              {"scope", sc},
              {"mod", mod}}));
  }

  Processor& proc_;
  std::shared_ptr<Settings> settings_;
  juce::WebBrowserComponent web_;
  std::unique_ptr<juce::FileChooser> chooser_;
  int settingsToken_ = 0;
  std::vector<float> lastValues_;
  std::vector<float> modBuf_;
  std::vector<uint32_t> lastGenerations_;
  uint32_t lastSerial_ = 0, lastLayoutSerial_ = 0;
  int selected_ = 0;   // the part the page is editing
  juce::uint32 sizeChangedAt_ = 0;

  JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(WebEditor)
};

juce::AudioProcessorEditor* makeEditor(Processor& p) { return new WebEditor(p); }

#else

juce::AudioProcessorEditor* makeEditor(Processor& p) { return new juce::GenericAudioProcessorEditor(p); }

#endif

}  // namespace skplugin
