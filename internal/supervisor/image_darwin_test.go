// ABOUTME: Proves provider startup from real Darwin process image replacement without parsing terminal output.
// ABOUTME: Rejects waiting wrappers, PID reuse, ended processes and replaced on-disk executable identities.

//go:build darwin && cgo

package supervisor

import (
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"testing"
	"time"
)

func TestNativeProviderImageAcrossExec(t *testing.T) {
	binary := imageFixtureBinary(t)
	preparation := imageFixture(t, binary)
	canonical, err := filepath.EvalSymlinks(preparation.Provider.Executable)
	if err != nil {
		t.Fatal(err)
	}
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	command := exec.Command(self, "-test.run=^TestNativeImageExecFixture$")
	command.Env = append(NormalEnvironment(os.Environ()), "BFB_NATIVE_IMAGE_EXEC="+preparation.Provider.Executable)
	command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	input, err := command.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = input.Close(); _ = command.Process.Kill(); _ = command.Wait() }()
	table, err := InspectProcesses()
	process := table[command.Process.Pid]
	if err != nil || !validRecordedProcess(process) {
		t.Fatal("wrapper identity missing", err)
	}
	if err := inspectProviderImage(process, preparation); err == nil {
		t.Fatal("waiting BFB wrapper counted as provider startup")
	}
	if _, err := input.Write([]byte{1}); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		err = inspectProviderImage(process, preparation)
		if err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("exec did not produce native provider evidence", err)
		}
		time.Sleep(10 * time.Millisecond)
	}
	reused := process
	reused.StartIdentity = "1:1"
	if err := inspectProviderImage(reused, preparation); err == nil {
		t.Fatal("wrong process start accepted")
	}
	// The original image remains running while its pathname is replaced. A
	// successful filesystem signature inspection must not validate the new image
	// as the code executing in the original process.
	if err := os.Rename(preparation.Provider.Executable, preparation.Provider.Executable+".original"); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(self)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(preparation.Provider.Executable, data, 0700); err != nil {
		t.Fatal(err)
	}
	if err := inspectProviderImage(process, preparation); err == nil {
		t.Fatal("replacement image inherited prepared identity")
	}
	path, nativeErr := nativeExecutable(process.PID)
	if nativeErr == nil && path == canonical {
		t.Fatal("dynamic image validation accepted the replaced on-disk executable")
	}
	if err := command.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	_ = command.Wait()
	if err := inspectProviderImage(process, preparation); err == nil {
		t.Fatal("ended process counted as provider startup")
	}
}

func TestNativeImageExecFixture(t *testing.T) {
	binary := os.Getenv("BFB_NATIVE_IMAGE_EXEC")
	if binary == "" {
		t.Skip("compiled process-image fixture")
	}
	data := make([]byte, 1)
	if _, err := io.ReadFull(os.Stdin, data); err != nil || data[0] != 1 {
		os.Exit(2)
	}
	if err := syscall.Exec(binary, []string{binary, "--mode", "interactive"}, []string{}); err != nil {
		os.Exit(3)
	}
}
