"""Preliminary native Job-list checks; this is not the recovery provider.

Run with Python on x64 Windows. Only fresh random Jobs and probe children are
terminated. No existing process, receipt, registry entry, or system setting is
changed. Failure remains an assertion failure and the probe exits nonzero.
"""

import contextlib
import ctypes as c
from ctypes import wintypes as w
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
import uuid

if sys.platform != 'win32' or c.sizeof(c.c_void_p) != 8:
    raise RuntimeError('This probe requires native x64 Windows')

k = c.WinDLL('kernel32', use_last_error=True)


class StartupInfo(c.Structure):
    _fields_ = [
        ('cb', w.DWORD), ('reserved', w.LPWSTR), ('desktop', w.LPWSTR),
        ('title', w.LPWSTR), ('x', w.DWORD), ('y', w.DWORD),
        ('xsize', w.DWORD), ('ysize', w.DWORD), ('xchars', w.DWORD),
        ('ychars', w.DWORD), ('fill', w.DWORD), ('flags', w.DWORD),
        ('show', w.WORD), ('reserved_size', w.WORD), ('reserved_bytes', c.c_void_p),
        ('stdin', w.HANDLE), ('stdout', w.HANDLE), ('stderr', w.HANDLE),
    ]


class StartupInfoEx(c.Structure):
    _fields_ = [('startup', StartupInfo), ('attributes', c.c_void_p)]


class ProcessInfo(c.Structure):
    _fields_ = [('process', w.HANDLE), ('thread', w.HANDLE),
                ('pid', w.DWORD), ('tid', w.DWORD)]


def bind(name, result, arguments):
    function = getattr(k, name)
    function.restype = result
    function.argtypes = arguments
    return function


create_job = bind('CreateJobObjectW', w.HANDLE, [c.c_void_p, w.LPCWSTR])
open_job = bind('OpenJobObjectW', w.HANDLE, [w.DWORD, w.BOOL, w.LPCWSTR])
set_job = bind('SetInformationJobObject', w.BOOL, [w.HANDLE, c.c_int, c.c_void_p, w.DWORD])
query_job = bind('QueryInformationJobObject', w.BOOL,
                 [w.HANDLE, c.c_int, c.c_void_p, w.DWORD, c.c_void_p])
terminate_job = bind('TerminateJobObject', w.BOOL, [w.HANDLE, w.UINT])
close = bind('CloseHandle', w.BOOL, [w.HANDLE])
wait = bind('WaitForSingleObject', w.DWORD, [w.HANDLE, w.DWORD])
resume = bind('ResumeThread', w.DWORD, [w.HANDLE])
open_process = bind('OpenProcess', w.HANDLE, [w.DWORD, w.BOOL, w.DWORD])
in_job = bind('IsProcessInJob', w.BOOL, [w.HANDLE, w.HANDLE, c.POINTER(w.BOOL)])
initialize_attributes = bind('InitializeProcThreadAttributeList', w.BOOL,
                             [c.c_void_p, w.DWORD, w.DWORD, c.POINTER(c.c_size_t)])
update_attributes = bind('UpdateProcThreadAttribute', w.BOOL,
                         [c.c_void_p, w.DWORD, c.c_size_t, c.c_void_p,
                          c.c_size_t, c.c_void_p, c.c_void_p])
delete_attributes = bind('DeleteProcThreadAttributeList', None, [c.c_void_p])
create_process = bind('CreateProcessW', w.BOOL,
                       [w.LPCWSTR, w.LPWSTR, c.c_void_p, c.c_void_p,
                        w.BOOL, w.DWORD, c.c_void_p, w.LPCWSTR,
                        c.POINTER(StartupInfoEx), c.POINTER(ProcessInfo)])


def checked(value):
    if not value:
        raise c.WinError(c.get_last_error())
    return value


def members(job):
    accounting = c.create_string_buffer(48)
    checked(query_job(job, 1, accounting, 48, None))
    return int.from_bytes(accounting.raw[40:44], 'little')


def await_empty(job):
    deadline = time.monotonic() + 5
    while members(job):
        if time.monotonic() >= deadline:
            raise AssertionError('New probe Job did not become empty')
        time.sleep(0.01)


def new_job(name=None):
    job = checked(create_job(None, name))
    limits = c.create_string_buffer(144)
    limits[16:20] = (0x2000).to_bytes(4, 'little')
    try:
        checked(set_job(job, 9, limits, 144))
    except BaseException:
        close(job)
        raise
    return job


@contextlib.contextmanager
def owned_job():
    job = new_job('Local\\DSH-atomic-probe-' + uuid.uuid4().hex)
    try:
        yield job
    finally:
        try:
            checked(terminate_job(job, 93))
            await_empty(job)
        finally:
            checked(close(job))


def atomic_create(job, code):
    size = c.c_size_t()
    c.set_last_error(0)
    result = initialize_attributes(None, 1, 0, c.byref(size))
    if result or c.get_last_error() != 122:
        raise AssertionError('Unexpected attribute-list sizing result')
    attributes = c.create_string_buffer(size.value)
    checked(initialize_attributes(attributes, 1, 0, c.byref(size)))
    try:
        job_value = w.HANDLE(job)
        checked(update_attributes(attributes, 0, 0x2000D, c.byref(job_value),
                                  c.sizeof(job_value), None, None))
        startup = StartupInfoEx()
        startup.startup.cb = c.sizeof(startup)
        startup.attributes = c.cast(attributes, c.c_void_p)
        info = ProcessInfo()
        command = c.create_unicode_buffer(subprocess.list2cmdline([sys.executable, '-c', code]))
        environment = {key: value for key, value in os.environ.items()
                       if not any(word in key.upper() for word in
                                  ('KEY', 'SECRET', 'TOKEN', 'PASSWORD'))
                       and not key.upper().startswith('DSH_')}
        environment_block = c.create_unicode_buffer('\0'.join(
            key + '=' + value for key, value in sorted(environment.items(), key=lambda item: item[0].upper())
        ) + '\0\0')
        # No AssignProcessToJobObject call exists in this launch path.
        checked(create_process(sys.executable, command, None, None, False,
                               0x80000 | 0x400 | 0x4 | 0x8,
                               environment_block, os.getcwd(), c.byref(startup), c.byref(info)))
        return info
    finally:
        delete_attributes(attributes)


@contextlib.contextmanager
def child(job, code, suspended=False):
    info = atomic_create(job, code)
    try:
        if not suspended and resume(info.thread) == 0xFFFFFFFF:
            raise c.WinError(c.get_last_error())
        yield info
    finally:
        checked(close(info.thread))
        checked(close(info.process))


def await_file(path):
    deadline = time.monotonic() + 5
    while not path.exists():
        if time.monotonic() >= deadline:
            raise AssertionError('Probe child did not reach its checkpoint')
        time.sleep(0.01)


class AtomicJobListTests(unittest.TestCase):
    def test_child_is_in_job_before_initial_resume(self):
        with owned_job() as job, child(job, 'pass', suspended=True) as info:
            associated = w.BOOL()
            checked(in_job(info.process, job, c.byref(associated)))
            self.assertTrue(associated.value)
            self.assertGreaterEqual(members(job), 1)
            self.assertEqual(wait(info.process, 0), 258)
            checked(terminate_job(job, 91))
            self.assertEqual(wait(info.process, 5000), 0)
            await_empty(job)

    def test_zero_members_between_two_sequential_children(self):
        with owned_job() as job:
            for _ in range(2):
                with child(job, 'pass') as info:
                    self.assertEqual(wait(info.process, 5000), 0)
                await_empty(job)
            # An empty Job still admits another child; emptiness is not a seal.
            with child(job, 'pass', suspended=True):
                self.assertGreaterEqual(members(job), 1)

    def test_direct_exit_does_not_hide_detached_grandchild(self):
        with tempfile.TemporaryDirectory(prefix='dsh-job-list-') as directory:
            checkpoint = Path(directory) / 'grandchild.txt'
            code = ('import pathlib, subprocess, sys; '
                    'grandchild = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(20)"], '
                    'creationflags=8, close_fds=True); '
                    f'pathlib.Path({str(checkpoint)!r}).write_text(str(grandchild.pid))')
            with owned_job() as job, child(job, code) as info:
                self.assertEqual(wait(info.process, 5000), 0)
                await_file(checkpoint)
                grandchild = checked(open_process(0x100000 | 0x1000, False, int(checkpoint.read_text())))
                try:
                    associated = w.BOOL()
                    checked(in_job(grandchild, job, c.byref(associated)))
                    self.assertTrue(associated.value)
                    self.assertEqual(wait(grandchild, 0), 258)
                    self.assertGreaterEqual(members(job), 1)
                    checked(terminate_job(job, 92))
                    self.assertEqual(wait(grandchild, 5000), 0)
                    await_empty(job)
                finally:
                    checked(close(grandchild))

    def test_breakaway_attempt_is_denied(self):
        with tempfile.TemporaryDirectory(prefix='dsh-job-list-') as directory:
            result = Path(directory) / 'breakaway.txt'
            code = ('import pathlib, subprocess, sys\n'
                    'try:\n'
                    ' subprocess.Popen([sys.executable, "-c", "pass"], creationflags=0x1000000)\n'
                    'except OSError as error:\n'
                    f' pathlib.Path({str(result)!r}).write_text(str(error.winerror))\n'
                    'else:\n'
                    f' pathlib.Path({str(result)!r}).write_text("ESCAPED")\n')
            with owned_job() as job, child(job, code) as info:
                self.assertEqual(wait(info.process, 5000), 0)
                await_file(result)
                self.assertEqual(result.read_text(), '5')
                await_empty(job)

    def test_last_runner_handle_close_kills_child_before_resume(self):
        # Observer retains only a process handle, never an operation Job handle.
        with tempfile.TemporaryDirectory(prefix='dsh-job-list-') as directory:
            checkpoint = Path(directory) / 'created.json'
            environment = {key: value for key, value in os.environ.items()
                           if not any(word in key.upper() for word in
                                      ('KEY', 'SECRET', 'TOKEN', 'PASSWORD'))
                           and not key.upper().startswith('DSH_')}
            runner = subprocess.Popen([sys.executable, __file__, '--crash-runner', str(checkpoint)],
                                      env=environment, creationflags=0x08000000)
            process = None
            try:
                await_file(checkpoint)
                data = json.loads(checkpoint.read_text())
                process = checked(open_process(0x100000 | 0x1000, False, data['pid']))
                self.assertEqual(wait(process, 0), 258)
                runner.kill()
                runner.wait(timeout=5)
                self.assertEqual(wait(process, 5000), 0)
            finally:
                if runner.poll() is None:
                    runner.kill()
                    runner.wait(timeout=5)
                if process:
                    checked(close(process))

    def test_failed_query_is_not_zero(self):
        with self.assertRaises(OSError):
            members(w.HANDLE(-1))


def crash_runner(checkpoint):
    job = new_job('Local\\DSH-atomic-probe-' + uuid.uuid4().hex)
    info = atomic_create(job, 'import time; time.sleep(20)')
    temporary = checkpoint.with_suffix('.tmp')
    temporary.write_text(json.dumps({'pid': info.pid}))
    temporary.replace(checkpoint)
    # The parent kills this runner at the post-create, pre-resume checkpoint.
    time.sleep(20)
    checked(terminate_job(job, 94))
    checked(close(info.thread))
    checked(close(info.process))
    checked(close(job))


if __name__ == '__main__':
    if len(sys.argv) == 3 and sys.argv[1] == '--crash-runner':
        crash_runner(Path(sys.argv[2]))
    else:
        unittest.main(verbosity=2)
