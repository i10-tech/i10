package config

import (
	"log/slog"
	"os"
)

// NewLogger is the JSON logger on stdout that authd and the mail front share,
// so the pod's output is one stream in one format. An unknown level is info.
func NewLogger(level string) *slog.Logger {
	var lvl slog.Level
	if err := lvl.UnmarshalText([]byte(level)); err != nil {
		lvl = slog.LevelInfo
	}
	return slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: lvl}))
}
