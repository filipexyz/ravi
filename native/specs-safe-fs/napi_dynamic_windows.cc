#ifdef _WIN32

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <node_api.h>

namespace {

template <typename Function>
Function host_function(const char* name) {
  HMODULE host = GetModuleHandleW(nullptr);
  return host == nullptr ? nullptr : reinterpret_cast<Function>(GetProcAddress(host, name));
}

#define RAVI_FORWARD_STATUS(name, parameters, arguments) \
  extern "C" napi_status NAPI_CDECL name parameters {   \
    auto function = host_function<decltype(&name)>(#name); \
    return function == nullptr ? napi_generic_failure : function arguments; \
  }

}  // namespace

extern "C" NAPI_NO_RETURN void NAPI_CDECL
napi_fatal_error(const char* location, size_t location_len, const char* message, size_t message_len) {
  auto function = host_function<decltype(&napi_fatal_error)>("napi_fatal_error");
  if (function != nullptr) function(location, location_len, message, message_len);
  TerminateProcess(GetCurrentProcess(), 134);
  __builtin_unreachable();
}

RAVI_FORWARD_STATUS(napi_delete_reference, (node_api_basic_env env, napi_ref ref), (env, ref))
RAVI_FORWARD_STATUS(
    napi_set_named_property,
    (napi_env env, napi_value object, const char* name, napi_value value),
    (env, object, name, value))
RAVI_FORWARD_STATUS(
    napi_open_escapable_handle_scope,
    (napi_env env, napi_escapable_handle_scope* result),
    (env, result))
RAVI_FORWARD_STATUS(napi_get_reference_value, (napi_env env, napi_ref ref, napi_value* result), (env, ref, result))
RAVI_FORWARD_STATUS(
    napi_get_named_property,
    (napi_env env, napi_value object, const char* name, napi_value* result),
    (env, object, name, result))
RAVI_FORWARD_STATUS(napi_is_exception_pending, (napi_env env, bool* result), (env, result))
RAVI_FORWARD_STATUS(
    napi_escape_handle,
    (napi_env env, napi_escapable_handle_scope scope, napi_value escapee, napi_value* result),
    (env, scope, escapee, result))
RAVI_FORWARD_STATUS(
    napi_close_escapable_handle_scope,
    (napi_env env, napi_escapable_handle_scope scope),
    (env, scope))
RAVI_FORWARD_STATUS(
    napi_get_last_error_info,
    (node_api_basic_env env, const napi_extended_error_info** result),
    (env, result))
RAVI_FORWARD_STATUS(napi_get_and_clear_last_exception, (napi_env env, napi_value* result), (env, result))
RAVI_FORWARD_STATUS(
    napi_create_string_utf8,
    (napi_env env, const char* value, size_t length, napi_value* result),
    (env, value, length, result))
RAVI_FORWARD_STATUS(
    napi_create_type_error,
    (napi_env env, napi_value code, napi_value message, napi_value* result),
    (env, code, message, result))
RAVI_FORWARD_STATUS(
    napi_create_error,
    (napi_env env, napi_value code, napi_value message, napi_value* result),
    (env, code, message, result))
RAVI_FORWARD_STATUS(
    napi_create_reference,
    (napi_env env, napi_value value, uint32_t initial_refcount, napi_ref* result),
    (env, value, initial_refcount, result))
RAVI_FORWARD_STATUS(napi_create_object, (napi_env env, napi_value* result), (env, result))
RAVI_FORWARD_STATUS(
    napi_define_properties,
    (napi_env env, napi_value object, size_t count, const napi_property_descriptor* properties),
    (env, object, count, properties))
RAVI_FORWARD_STATUS(
    napi_get_value_string_utf8,
    (napi_env env, napi_value value, char* buffer, size_t size, size_t* result),
    (env, value, buffer, size, result))
RAVI_FORWARD_STATUS(
    napi_create_function,
    (napi_env env, const char* name, size_t length, napi_callback callback, void* data, napi_value* result),
    (env, name, length, callback, data, result))
RAVI_FORWARD_STATUS(
    napi_add_finalizer,
    (napi_env env,
     napi_value object,
     void* data,
     node_api_basic_finalize callback,
     void* hint,
     napi_ref* result),
    (env, object, data, callback, hint, result))
RAVI_FORWARD_STATUS(napi_typeof, (napi_env env, napi_value value, napi_valuetype* result), (env, value, result))
RAVI_FORWARD_STATUS(napi_get_undefined, (napi_env env, napi_value* result), (env, result))
RAVI_FORWARD_STATUS(
    napi_create_array_with_length,
    (napi_env env, size_t length, napi_value* result),
    (env, length, result))
RAVI_FORWARD_STATUS(
    napi_set_element,
    (napi_env env, napi_value object, uint32_t index, napi_value value),
    (env, object, index, value))
RAVI_FORWARD_STATUS(napi_is_array, (napi_env env, napi_value value, bool* result), (env, value, result))
RAVI_FORWARD_STATUS(
    napi_get_array_length,
    (napi_env env, napi_value value, uint32_t* result),
    (env, value, result))
RAVI_FORWARD_STATUS(
    napi_get_element,
    (napi_env env, napi_value object, uint32_t index, napi_value* result),
    (env, object, index, result))
RAVI_FORWARD_STATUS(napi_get_value_bool, (napi_env env, napi_value value, bool* result), (env, value, result))
RAVI_FORWARD_STATUS(napi_open_handle_scope, (napi_env env, napi_handle_scope* result), (env, result))
RAVI_FORWARD_STATUS(napi_throw, (napi_env env, napi_value error), (env, error))
RAVI_FORWARD_STATUS(napi_close_handle_scope, (napi_env env, napi_handle_scope scope), (env, scope))
RAVI_FORWARD_STATUS(
    napi_get_cb_info,
    (napi_env env,
     napi_callback_info info,
     size_t* argc,
     napi_value* argv,
     napi_value* this_arg,
     void** data),
    (env, info, argc, argv, this_arg, data))
RAVI_FORWARD_STATUS(
    napi_has_property,
    (napi_env env, napi_value object, napi_value key, bool* result),
    (env, object, key, result))
RAVI_FORWARD_STATUS(
    napi_get_property,
    (napi_env env, napi_value object, napi_value key, napi_value* result),
    (env, object, key, result))
RAVI_FORWARD_STATUS(
    napi_call_function,
    (napi_env env,
     napi_value receiver,
     napi_value function_value,
     size_t argc,
     const napi_value* argv,
     napi_value* result),
    (env, receiver, function_value, argc, argv, result))
RAVI_FORWARD_STATUS(napi_get_boolean, (napi_env env, bool value, napi_value* result), (env, value, result))
RAVI_FORWARD_STATUS(napi_create_double, (napi_env env, double value, napi_value* result), (env, value, result))

#endif
