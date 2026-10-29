# synthkit_add_synth(<name> SOURCES <files...> [DIR <synth dir>])
#
# Builds a synth on synthkit. DIR (default: the current source dir) must
# contain synth.json and may contain presets/*.json and tests/*.json.
# Creates:
#   <name>_synth   static library: the synth + embedded synth.json/presets
#   <name>_render  offline render + check tool (see API.md §10)
#   a CTest test   "<name>_check" running every test scenario + generic checks

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

  add_executable(${name}_render "${SYNTHKIT_ROOT}/tools/render/main.cpp" "${SYNTHKIT_ROOT}/tools/render/wav.cpp")
  target_link_libraries(${name}_render PRIVATE ${name}_synth)
  target_include_directories(${name}_render PRIVATE "${SYNTHKIT_ROOT}/tools/render")

  if(BUILD_TESTING)
    add_test(NAME ${name}_check COMMAND ${name}_render --check "${SK_DIR}")
  endif()
endfunction()
