# Plugin builds (VST3, AU on macOS, Standalone), with JUCE. Included from the
# top-level CMakeLists.txt when SYNTHKIT_PLUGIN is on (after enabling C, and
# OBJC/OBJCXX on macOS); everything else in synthkit stays JUCE-free.
#
# JUCE is fetched at a pinned version. To use a local checkout instead:
#   -DFETCHCONTENT_SOURCE_DIR_JUCE=/path/to/JUCE
#
# The plugin window shows the synth's browser page. Build the web target first
# (cmake/wasm32-wasi.cmake) and pass the folder holding <name>.html:
#   -DSYNTHKIT_WEB_UI_DIR=build-web/web
# Without it the plugin still builds, with JUCE's plain parameter list as its
# window (handy for quick native-only builds).

include_guard(GLOBAL)

set(SYNTHKIT_JUCE_VERSION "9.0.4" CACHE INTERNAL "")
set(SYNTHKIT_WEB_UI_DIR "" CACHE PATH "Folder with the packed <synth>.html pages for the plugin window")
set(SYNTHKIT_PLUGIN_FORMATS "" CACHE STRING "Override plugin formats (default: VST3 Standalone, plus AU on macOS)")

include(FetchContent)
FetchContent_Declare(JUCE
  GIT_REPOSITORY https://github.com/juce-framework/JUCE.git
  GIT_TAG ${SYNTHKIT_JUCE_VERSION}
  GIT_SHALLOW TRUE
  GIT_PROGRESS TRUE)
FetchContent_MakeAvailable(JUCE)

function(_synthkit_add_plugin name dir)
  file(READ "${dir}/synth.json" _json)
  foreach(key id name vendor version pluginCode vendorCode)
    string(JSON _v ERROR_VARIABLE _err GET "${_json}" ${key})
    if(_err)
      set(_v "")
    endif()
    set(_sk_${key} "${_v}")
  endforeach()
  foreach(key name vendor pluginCode vendorCode)
    if(_sk_${key} STREQUAL "")
      message(FATAL_ERROR "synthkit plugin ${name}: synth.json needs \"${key}\" to build a plugin")
    endif()
  endforeach()
  if(_sk_version STREQUAL "")
    set(_sk_version "0.1.0")
  endif()
  # Bundle id: permanent once released (macOS identifies the AU by it).
  string(TOLOWER "${_sk_vendor}" _vendor_id)
  string(REGEX REPLACE "[^a-z0-9-]" "-" _vendor_id "${_vendor_id}")
  string(JSON _bundle ERROR_VARIABLE _err GET "${_json}" bundleId)
  if(_err OR _bundle STREQUAL "")
    set(_bundle "com.${_vendor_id}.${_sk_id}")
  endif()

  if(SYNTHKIT_PLUGIN_FORMATS)
    set(_formats ${SYNTHKIT_PLUGIN_FORMATS})
  else()
    set(_formats VST3 Standalone)
    if(APPLE)
      list(APPEND _formats AU)
    endif()
  endif()

  juce_add_plugin(${name}_plugin
    PRODUCT_NAME "${_sk_name}"
    COMPANY_NAME "${_sk_vendor}"
    VERSION "${_sk_version}"
    BUNDLE_ID "${_bundle}"
    PLUGIN_MANUFACTURER_CODE "${_sk_vendorCode}"
    PLUGIN_CODE "${_sk_pluginCode}"
    FORMATS ${_formats}
    IS_SYNTH TRUE
    NEEDS_MIDI_INPUT TRUE
    NEEDS_MIDI_OUTPUT FALSE
    IS_MIDI_EFFECT FALSE
    EDITOR_WANTS_KEYBOARD_FOCUS TRUE
    VST3_CATEGORIES Instrument Synth
    AU_MAIN_TYPE kAudioUnitType_MusicDevice
    NEEDS_WEB_BROWSER TRUE
    NEEDS_WEBVIEW2 TRUE
    COPY_PLUGIN_AFTER_BUILD FALSE)

  set(_html "")
  if(SYNTHKIT_WEB_UI_DIR)
    get_filename_component(_ui_dir "${SYNTHKIT_WEB_UI_DIR}" ABSOLUTE BASE_DIR "${CMAKE_BINARY_DIR}")
    set(_html "${_ui_dir}/${name}.html")
    if(NOT EXISTS "${_html}")
      message(FATAL_ERROR "synthkit plugin ${name}: ${_html} not found (build the web target first, see cmake/plugin.cmake)")
    endif()
  endif()
  if(_html)
    juce_add_binary_data(${name}_plugin_ui HEADER_NAME SkPluginUi.h NAMESPACE SkPluginUi SOURCES "${_html}")
    set_target_properties(${name}_plugin_ui PROPERTIES POSITION_INDEPENDENT_CODE ON)
    target_link_libraries(${name}_plugin PRIVATE ${name}_plugin_ui)
    target_compile_definitions(${name}_plugin PRIVATE SK_PLUGIN_HAS_UI=1)
  else()
    target_compile_definitions(${name}_plugin PRIVATE SK_PLUGIN_HAS_UI=0)
  endif()

  target_sources(${name}_plugin PRIVATE
    "${SYNTHKIT_ROOT}/plugin/Processor.cpp"
    "${SYNTHKIT_ROOT}/plugin/Editor.cpp"
    "${SYNTHKIT_ROOT}/plugin/Settings.cpp")
  target_include_directories(${name}_plugin PRIVATE "${SYNTHKIT_ROOT}/plugin")
  target_compile_definitions(${name}_plugin PRIVATE
    JUCE_WEB_BROWSER=1
    JUCE_USE_CURL=0
    JUCE_USE_WIN_WEBVIEW2_WITH_STATIC_LINKING=1
    JUCE_VST3_CAN_REPLACE_VST2=0
    JUCE_DISPLAY_SPLASH_SCREEN=0
    JUCE_REPORT_APP_USAGE=0
    JUCE_SILENCE_XCODE_15_LINKER_WARNING=1
    JUCE_MODAL_LOOPS_PERMITTED=0)
  set_target_properties(${name}_synth synthkit_core PROPERTIES POSITION_INDEPENDENT_CODE ON)
  target_link_libraries(${name}_plugin PRIVATE
    ${name}_synth
    juce::juce_audio_utils
    juce::juce_gui_extra
    juce::juce_recommended_config_flags)

  # Loads the built VST3 like a DAW and checks it against the engine.
  juce_add_console_app(${name}_plugin_check PRODUCT_NAME "${name}_plugin_check" VERSION "${_sk_version}")
  target_sources(${name}_plugin_check PRIVATE "${SYNTHKIT_ROOT}/plugin/test/PluginCheck.cpp")
  target_compile_definitions(${name}_plugin_check PRIVATE
    JUCE_PLUGINHOST_VST3=1 JUCE_USE_CURL=0 JUCE_WEB_BROWSER=0 JUCE_MODAL_LOOPS_PERMITTED=1)   # runDispatchLoopUntil, for the plugin's message-thread work
  target_link_libraries(${name}_plugin_check PRIVATE
    ${name}_synth juce::juce_audio_processors juce::juce_audio_utils juce::juce_recommended_config_flags)
  add_dependencies(${name}_plugin_check ${name}_plugin_VST3)
endfunction()
