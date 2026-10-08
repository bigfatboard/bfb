// ABOUTME: Atomically exchanges provider configuration files on macOS without discarding raced edits.
// ABOUTME: Uses directory-relative APFS rename operations while preserving the displaced file for validation.

package provider

import "golang.org/x/sys/unix"

func exchangeConfig(directory int, staged, current string) error {
	return unix.RenameatxNp(directory, staged, directory, current, unix.RENAME_SWAP)
}

func moveConfig(directory int, current, staged string) error {
	return unix.RenameatxNp(directory, current, directory, staged, unix.RENAME_EXCL)
}
