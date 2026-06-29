#ifndef SHEPHERDD_BRIDGING_H
#define SHEPHERDD_BRIDGING_H

#include <util.h>        // forkpty
#include <sys/ioctl.h>
#include <termios.h>     // struct winsize

// Swift cannot call the variadic ioctl(2); expose the two calls we need.
static inline int sh_get_winsize(int fd, struct winsize *ws) { return ioctl(fd, TIOCGWINSZ, ws); }
static inline int sh_set_winsize(int fd, const struct winsize *ws) { return ioctl(fd, TIOCSWINSZ, ws); }

#endif
