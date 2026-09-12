// ABOUTME: Dispatches the BFB CLI and per-user daemon through registered leaf commands.
// ABOUTME: Handles process cancellation without exposing raw local errors or credentials.

package main

import (
	"context"
	"os"
	"os/signal"
	"syscall"

	"github.com/qdis/bfb/internal/appbridge"
	"github.com/qdis/bfb/internal/checkout"
	"github.com/qdis/bfb/internal/cli"
	"github.com/qdis/bfb/internal/daemon"
	"github.com/qdis/bfb/internal/runner"
)

func main() {
	syscall.Umask(0077)
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	methods := daemon.NewRegistry()
	if err := appbridge.RegisterRPC(methods, appbridge.New(appbridge.Options{})); err != nil {
		panic("duplicate built-in app operation")
	}
	if err := checkout.RegisterRPC(methods); err != nil {
		panic("duplicate built-in local operation")
	}
	if err := runner.RegisterRPC(methods, runner.NewManager(runner.ManagerOptions{})); err != nil {
		panic("duplicate built-in runner operation")
	}
	registry := cli.NewRegistry()
	cli.RegisterDaemon(registry, methods)
	cli.RegisterCheckout(registry)
	cli.RegisterRunner(registry)
	os.Exit(registry.Execute(ctx, os.Args[1:], os.Stdin, os.Stdout))
}
