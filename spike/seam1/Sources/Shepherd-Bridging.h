#import <IOKit/pwr_mgt/IOPM.h>

// kIOPMMessageClamshellStateChange is a function-like macro
// (iokit_family_msg(...)), so Swift cannot import it. Re-expose its value as a
// plain constant the Swift importer can see.
static const UInt32 kShepherdIOPMMessageClamshellStateChange = kIOPMMessageClamshellStateChange;

// The vendored editor's ObjC helper. Upstream reached it via `import
// CodeEditTextViewObjC`; in one module there is no such module, so it comes in
// through the bridging header instead.
#import "CGContextHidden.h"
