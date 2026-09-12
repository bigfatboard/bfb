// ABOUTME: Restores a Terminal foreground group only while it still belongs to this supervisor's provider.
// ABOUTME: Blocks SIGTTOU on the calling native thread throughout inspection and foreground transfer.

//go:build darwin && cgo

package supervisor

/*
#include <errno.h>
#include <pthread.h>
#include <signal.h>
#include <unistd.h>

static int bfb_restore_foreground(int fd, int expected, int target) {
  sigset_t blocked, previous;
  sigemptyset(&blocked);
  sigaddset(&blocked, SIGTTOU);
  int status = pthread_sigmask(SIG_BLOCK, &blocked, &previous);
  if (status != 0) return -status;
  int result = 0;
  pid_t current = tcgetpgrp(fd);
  if (current < 0) result = -errno;
  else if (current == expected) result = tcsetpgrp(fd, target) == 0 ? 1 : -errno;
  status = pthread_sigmask(SIG_SETMASK, &previous, NULL);
  return status != 0 ? -status : result;
}
*/
import "C"

func RestoreForeground(fd, expected, target int) (bool, error) {
	if fd < 0 || expected <= 1 || target <= 1 {
		return false, failure("invalid_request")
	}
	result := int(C.bfb_restore_foreground(C.int(fd), C.int(expected), C.int(target)))
	if result < 0 {
		return false, failure("execution_terminal_lost")
	}
	return result == 1, nil
}
