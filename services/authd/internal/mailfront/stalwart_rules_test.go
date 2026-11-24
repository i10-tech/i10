package mailfront

// A port of how Stalwart v1.1.0 reads a client's bytes, for the fake upstream
// only (v1.2.0 reads the same grammar; only its request size accounting
// changed, which this port does not model). It is written from Stalwart's source (crates/imap-proto/src/
// receiver.rs, Receiver::parse; crates/smtp-proto, Rfc5321Parser::hashed_value)
// and on purpose shares NOTHING with the front's own reader: a test can only
// catch the two disagreeing if they are two different readings.
//
// ⚠ FAITHFUL WHERE IT MATTERS FOR A DIFFERENCE: a tag drops a tab or a CR; a
// verb ends at any whitespace; a quote or a `{` open a string or a literal only
// after whitespace (or `~` alone), and are ordinary bytes anywhere else; a
// parse error is answered and reading CONTINUES from the next byte, the rest of
// the line included. That last one is what turned `a NOOP x{N}` into a hidden
// second command.

import (
	"bufio"
	"errors"
	"io"
	"strconv"
	"strings"
)

var errStalwartParse = errors.New("stalwart parse error")

type stalwartRequest struct {
	tag, command string
	args         []string // "(" and ")" are their own entries; NIL is "\x00NIL"
}

const stalNil = "\x00NIL"

func isStalWS(c byte) bool { return c == ' ' || c == '\t' || c == '\n' || c == '\f' || c == '\r' }

// stalwartReadIMAP reads one request. needsLiteral is called for a
// synchronizing literal, where Stalwart sends its "+". On errStalwartParse the
// caller answers BAD and calls again: the reader resumes at the next byte.
func stalwartReadIMAP(r *bufio.Reader, needsLiteral func()) (*stalwartRequest, error) {
	req := &stalwartRequest{}
	// Start.
	var c byte
	var err error
	for {
		if c, err = r.ReadByte(); err != nil {
			return nil, err
		}
		if !isStalWS(c) {
			break
		}
	}
	// Tag: a run until space, tab, CR or LF; tab and CR are dropped.
	tag := []byte{c}
	for {
		if c, err = r.ReadByte(); err != nil {
			return nil, err
		}
		switch c {
		case ' ':
			if len(tag) > 0 {
				req.tag = string(tag)
				goto command
			}
		case '\t', '\r':
		case '\n':
			return nil, errStalwartParse
		default:
			if len(tag) >= 128 {
				return nil, errStalwartParse
			}
			tag = append(tag, c)
		}
	}
command:
	{
		var cmd []byte
		for {
			if c, err = r.ReadByte(); err != nil {
				return nil, err
			}
			if (c >= '0' && c <= '9') || (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') {
				if len(cmd) >= 15 {
					return nil, errStalwartParse
				}
				cmd = append(cmd, c) // upper-cased when the verb ends
				continue
			}
			if !isStalWS(c) {
				return nil, errStalwartParse
			}
			if len(cmd) == 0 {
				continue
			}
			req.command = strings.ToUpper(string(cmd))
			if c == '\n' {
				return req, nil
			}
			break
		}
	}
	// Arguments.
	var buf []byte
	last := byte(' ')
	push := func(inQuote bool) {
		if len(buf) > 0 {
			req.args = append(req.args, string(buf))
			buf = buf[:0]
		} else if inQuote {
			req.args = append(req.args, stalNil)
		}
	}
	for {
		if c, err = r.ReadByte(); err != nil {
			return nil, err
		}
		switch {
		case c == '"' && isStalWS(last):
			push(false)
			// Quoted.
			for {
				if c, err = r.ReadByte(); err != nil {
					return nil, err
				}
				if c == '"' {
					push(true)
					last = ' '
					break
				}
				if c == '\\' {
					e, err := r.ReadByte()
					if err != nil {
						return nil, err
					}
					if e == '\n' {
						return nil, errStalwartParse
					}
					if e != '"' && e != '\\' {
						buf = append(buf, '\\')
					}
					buf = append(buf, e)
					continue
				}
				if c == '\n' {
					return nil, errStalwartParse
				}
				buf = append(buf, c)
			}
		case c == '{' && (isStalWS(last) || (last == '~' && len(buf) == 1)):
			if last != '~' {
				push(false)
			} else {
				buf = buf[:0]
			}
			var digits []byte
			nonSync := false
			for {
				if c, err = r.ReadByte(); err != nil {
					return nil, err
				}
				if c == '}' {
					if len(digits) == 0 {
						return nil, errStalwartParse
					}
					break
				}
				if c == '+' && len(digits) > 0 && !nonSync {
					nonSync = true
					continue
				}
				if c >= '0' && c <= '9' && !nonSync && len(digits) < 15 {
					digits = append(digits, c)
					continue
				}
				return nil, errStalwartParse
			}
			size, _ := strconv.Atoi(string(digits))
			// LiteralSeek: whitespace up to LF.
			for {
				if c, err = r.ReadByte(); err != nil {
					return nil, err
				}
				if c == '\n' {
					break
				}
				if !isStalWS(c) {
					return nil, errStalwartParse
				}
			}
			if !nonSync {
				needsLiteral()
			}
			if size == 0 {
				req.args = append(req.args, stalNil)
			} else {
				lit := make([]byte, size)
				if _, err := io.ReadFull(r, lit); err != nil {
					return nil, err
				}
				req.args = append(req.args, string(lit))
			}
			last = ' '
		case c == '(' || c == ')':
			push(false)
			req.args = append(req.args, string(c))
		case c == '\n':
			push(false)
			return req, nil
		case isStalWS(c):
			push(false)
			last = c
		default:
			buf = append(buf, c)
			last = c
		}
	}
}

// stalwartSMTPVerb is Rfc5321Parser::hashed_value: leading spaces skipped,
// every CR skipped, letters and digits taken, and the verb ends at the first
// other byte, which must be whitespace. It returns the rest of the line too,
// CRs removed.
func stalwartSMTPVerb(line string) (verb, rest string, ok bool) {
	var v []byte
	i := 0
	for ; i < len(line); i++ {
		c := line[i]
		isTok := (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')
		if isTok {
			v = append(v, c)
			continue
		}
		if c == '\r' || (c == ' ' && len(v) == 0) {
			continue
		}
		break
	}
	if i < len(line) && !isStalWS(line[i]) {
		return "", "", false
	}
	if i < len(line) {
		i++
	}
	return strings.ToUpper(string(v)), strings.ReplaceAll(strings.TrimRight(line[i:], "\r\n"), "\r", ""), true
}
