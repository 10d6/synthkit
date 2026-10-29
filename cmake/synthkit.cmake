# synthkit_add_synth(<name> SOURCES <files...> [DIR <synth dir>])
#
# Builds a synth on synthkit. DIR (default: the current source dir) must
# contain synth.json and may contain presets/*.json and tests/*.json.
# Creates:
#   <name>_synth   static library: the synth + embedded synth.json/presets
#   <name>_render  offline render + check tool (see API.md §10)
#   a CTest test   "<name>_check" running every test scenario + generic checks
# With the browser toolchain (cmake/wasm32-wasi.cmake) it instead creates:
#   <name>_web     web/<name>.html: the whole synth in one self-contained page

set(SYNTHKIT_ROOT "${CMAKE_CURRENT_LIST_DIR}/.." CACHE INTERNAL "")

function(synthkit_add_synth name)
  cmake_parse_arguments(SK "" "DIR" "SOURCES" ${ARGN})
  if(NOT SK_DIR)
    set(SK_DIR "${CMAKE_CURRENT_SOURCE_DIR}")
  endif()
  get_filename_component(SK_DIR "${SK_DIR}" ABSOLUTE)
  if(NOT EXISTS "${SK_DIR}/synth.json")
    message(FATAL_ERROR "synthkit_add_synth(${name}): ${SK_DIR}/synth.json not found")
  endif()

  file(GLOB _presets CONFIGURE_DEPENDS "${SK_DIR}/presets/*.json")
  set(_embedded "${CMAKE_CURRENT_BINARY_DIR}/${name}_embedded.cpp")
  add_custom_command(
    OUTPUT "${_embedded}"
    COMMAND "${CMAKE_COMMAND}" -DSYNTH_DIR=${SK_DIR} -DOUT=${_embedded} -P "${SYNTHKIT_ROOT}/cmake/embed.cmake"
    DEPENDS "${SK_DIR}/synth.json" ${_presets} "${SYNTHKIT_ROOT}/cmake/embed.cmake"
    COMMENT "Embedding ${name} synth.json and presets"
    VERBATIM)

  add_library(${name}_synth STATIC ${SK_SOURCES} "${_embedded}" "${SYNTHKIT_ROOT}/core/src/make_engine.cpp")
  target_link_libraries(${name}_synth PUBLIC synthkit_core)

  if(SYNTHKIT_WASM)
    _synthkit_add_web(${name} "${SK_DIR}")
    return()
  endif()

  add_executable(${name}_render "${SYNTHKIT_ROOT}/tools/render/main.cpp" "${SYNTHKIT_ROOT}/tools/render/wav.cpp")
  target_link_libraries(${name}_render PRIVATE ${name}_synth)
  target_include_directories(${name}_render PRIVATE "${SYNTHKIT_ROOT}/tools/render")

  if(BUILD_TESTING)
    add_test(NAME ${name}_check COMMAND ${name}_render --check "${SK_DIR}")
  endif()
endfunction()

function(_synthkit_add_web name dir)
  find_package(Python3 REQUIRED COMPONENTS Interpreter)
  add_executable(${name}_wasm "${SYNTHKIT_ROOT}/web/wasm/api.cpp" "${SYNTHKIT_ROOT}/web/wasm/noexcept.cpp")
  target_link_libraries(${name}_wasm PRIVATE ${name}_synth)
  set_target_properties(${name}_wasm PROPERTIES SUFFIX ".wasm")
  target_link_options(${name}_wasm PRIVATE -mexec-model=reactor -Wl,--strip-all -Wl,-z,stack-size=1048576)

  file(GLOB_RECURSE _shell CONFIGURE_DEPENDS "${SYNTHKIT_ROOT}/web/shell/*")
  file(GLOB _ui CONFIGURE_DEPENDS "${dir}/ui/*")
  set(_out "${CMAKE_BINARY_DIR}/web/${name}.html")
  add_custom_command(
    OUTPUT "${_out}"
    COMMAND "${Python3_EXECUTABLE}" "${SYNTHKIT_ROOT}/web/pack.py"
            --wasm "$<TARGET_FILE:${name}_wasm>" --synth-dir "${dir}" --out "${_out}"
    DEPENDS ${name}_wasm ${_shell} ${_ui} "${SYNTHKIT_ROOT}/web/pack.py"
    COMMENT "Packing ${name}.html"
    VERBATIM)
  add_custom_target(${name}_web ALL DEPENDS "${_out}")
endfunction()
