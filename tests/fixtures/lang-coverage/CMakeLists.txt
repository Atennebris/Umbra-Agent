cmake_minimum_required(VERSION 3.20)
project(UmbraCore VERSION 1.0.0)

set(CMAKE_CXX_STANDARD 20)
set(BUILD_SHARED_LIBS ON)

option(ENABLE_TESTS "Build tests" ON)
option(ENABLE_ASAN "Enable address sanitizer" OFF)

add_library(umbra_core src/core.cpp src/config.cpp)
add_executable(umbra_daemon src/daemon.cpp)
add_executable(umbra_cli src/cli.cpp)

function(target_setup_warnings TARGET)
  target_compile_options(${TARGET} PRIVATE -Wall -Wextra)
endfunction()

macro(add_umbra_test NAME)
  add_executable(${NAME} tests/${NAME}.cpp)
  target_link_libraries(${NAME} umbra_core)
endmacro()
