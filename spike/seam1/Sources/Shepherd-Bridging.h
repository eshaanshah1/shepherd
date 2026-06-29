#import <IOKit/pwr_mgt/IOPM.h>

// kIOPMMessageClamshellStateChange is a function-like macro
// (iokit_family_msg(...)), so Swift cannot import it. Re-expose its value as a
// plain constant the Swift importer can see.
static const UInt32 kShepherdIOPMMessageClamshellStateChange = kIOPMMessageClamshellStateChange;
