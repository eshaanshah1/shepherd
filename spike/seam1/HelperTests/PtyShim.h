#ifndef PTY_SHIM_H
#define PTY_SHIM_H

#include <util.h>        // openpty
#include <sys/ioctl.h>
#include <termios.h>

static inline int pty_set_winsize(int fd, const struct winsize *ws) { return ioctl(fd, TIOCSWINSZ, ws); }

#endif
