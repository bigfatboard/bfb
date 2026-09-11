// ABOUTME: Dispatches the BFB CLI and per-user daemon through registered leaf commands.
// ABOUTME: Handles process cancellation without exposing raw local errors or credentials.

package main

import (
	"context"
	"os"
	"os/signal"
	"syscall"

	"github.com/qdis/bfb/internal/cli"
)

func main() {
	syscall.Umask(0077)
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	registry := cli.NewRegistry()
	cli.RegisterDaemon(registry)
	os.Exit(registry.Execute(ctx, os.Args[1:], os.Stdin, os.Stdout))
}
