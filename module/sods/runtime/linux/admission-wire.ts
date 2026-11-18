// Private static Wasm wire checks used by the current host and trusted builder.
// This inspects bytes already selected by their own policy. No execution,
// import resolution, guest memory, result owner or Node facility is created.
const Module = WebAssembly.Module, Bytes = Uint8Array;

const ordinaryOnly = ['linux_sendfile_cap_start', 'linux_sendfile_cap_finish', 'linux_sendfile_load_start', 'linux_sendfile_load_finish',
  'linux_sendfile_start', 'linux_sendfile_receipt', 'linux_sendfile_cleanup', 'linux_sendfile_query',
  'linux_startup_begin', 'linux_startup_begin_stdio', 'linux_execution_create'];
const resultOnly = ['linux_capture_candidate', 'linux_capture_select', 'linux_capture_result_init', 'linux_capture_result_startup',
  'linux_capture_result_resume', 'linux_capture_result_write_start', 'linux_capture_result_write_finish', 'linux_capture_result_head',
  'linux_capture_result_copy_start', 'linux_capture_result_copy_finish'];
const required = ['linux_task_registration', 'linux_syscall_sequenced', 'linux_register_start', 'linux_register_receipt', 'linux_root_input', 'linux_prepared_root', 'linux_root_source', 'linux_root_artifact', 'linux_startup_artifact_start', 'linux_startup_artifact_finish', 'linux_prepared_files', 'linux_startup_input', 'linux_stream_start', 'linux_stream_receipt', 'linux_result_endpoint', 'linux_startup_source_start', 'linux_startup_source_finish', 'linux_startup_bytes', 'linux_startup_translation_finish', 'linux_startup_image_begin', 'linux_startup_stack', 'linux_startup_image_finish', 'linux_startup_cancel', 'linux_startup_failed_image', 'linux_startup_entry', 'linux_startup_check', 'linux_stack_input', 'linux_stack_build', 'linux_stack_clear', 'linux_run_start', 'linux_run_receipt', 'linux_syscall', 'linux_syscall_complete',
  'linux_syscall_path_start', 'linux_syscall_path_finish', 'linux_syscall_resumed', 'linux_syscall_abandon', 'linux_syscall_load_finish', 'linux_result_auxiliary', 'linux_abi_version', 'linux_init', 'linux_result', 'linux_bind', 'linux_span',
  'linux_binding_room', 'linux_change', 'linux_start', 'linux_receipt', 'linux_retire',
  'linux_files_prepare', 'linux_name', 'linux_input', 'linux_tree_directory', 'linux_tree_file', 'linux_tree_symlink',
  'linux_files_seal', 'linux_open', 'linux_dup', 'linux_close', 'linux_offset', 'linux_seek',
  'linux_read_begin', 'linux_read_start', 'linux_read_receipt', 'linux_read_query',
  'linux_read_cancel', 'linux_read_retire', 'linux_result_length', 'linux_result_state',
  'linux_execution_retire', 'linux_execution_unstarted_stopped', 'linux_image_begin', 'linux_image_finish', 'linux_tree_lazy',
  'linux_managed_read_begin', 'linux_read_load_start', 'linux_load_input',
  'linux_read_load_finish', 'linux_managed_read_start'];
export function validateCaptureResultIdentity(module: WebAssembly.Module): void {
  const wire = Module.customSections(module, 'sods.linux.capture');
  const identity = [83, 79, 68, 83, 67, 65, 80, 0, 7, 4, 2, 0];
  if (wire.length !== 1 || wire[0]!.byteLength !== identity.length ||
      !new Bytes(wire[0]!).every((byte, i) => byte === identity[i])) {
    throw new Error('Unsupported captured result artifact identity');
  }
}

export function validateLinuxMemorySurface(module: WebAssembly.Module, captureResult: boolean): void {
  const exports = Module.exports(module);
  const names = new Map(exports.map(e => [e.name, e.kind]));
  // A probe has synthetic physical truth, never a usable host capability. Reject
  // before instantiation, even when all required names/version are present.
  if (names.has('linux_sendfile_probe') || names.has('linux_sendfile_probe_access_ended')) {
    throw new Error('Synthetic sendfile probe is not a production Linux admission module');
  }
  if (!captureResult && names.has('linux_capture_candidate')) {
    throw new Error('Linux capture candidate is not an ordinary Linux admission module');
  }
  if (Module.imports(module).length || names.get('memory') !== 'memory' ||
      required.some(name => names.get(name) !== 'function') ||
      (captureResult ? resultOnly : ordinaryOnly).some(name => names.get(name) !== 'function') ||
      (captureResult && (ordinaryOnly.some(name => names.has(name)) ||
        exports.some(e => e.name.startsWith('linux_queued_') || e.name.startsWith('linux_sendfile_'))))) {
    throw new Error('Unsupported Linux admission module');
  }
}
