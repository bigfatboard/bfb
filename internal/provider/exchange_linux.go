// ABOUTME: Atomically exchanges provider configuration files on Linux without discarding raced edits.
// ABOUTME: Fails closed on filesystems without exchange support instead of replacing unvalidated content.

package provider

import "golang.org/x/sys/unix"

func exchangeConfig(directory int, staged, current string) error {
	return unix.Renameat2(directory, staged, directory, current, unix.RENAME_EXCHANGE)
}

func moveConfig(directory int, current, staged string) error {
	return unix.Renameat2(directory, current, directory, staged, unix.RENAME_NOREPLACE)
}
