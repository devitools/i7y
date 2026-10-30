#import <Foundation/Foundation.h>
#import <Security/Security.h>
#import <libproc.h>
#import <string.h>

int i7y_mcp_verify_desktop(int pid, const char *expected, int development) {
    @autoreleasepool {
        char path[PROC_PIDPATHINFO_MAXSIZE];
        if (pid <= 0 || !expected || proc_pidpath(pid, path, sizeof(path)) <= 0 || strcmp(path, expected) != 0) return 1;
        if (development) return 0;

        SecCodeRef own = NULL;
        if (SecCodeCopySelf(kSecCSDefaultFlags, &own) != errSecSuccess) return 1;
        OSStatus status = SecCodeCheckValidity(own, kSecCSStrictValidate, NULL);
        if (status != errSecSuccess) { CFRelease(own); return 1; }

        CFDictionaryRef info = NULL;
        status = SecCodeCopySigningInformation(own, kSecCSSigningInformation, &info);
        if (status != errSecSuccess) { CFRelease(own); return 1; }
        NSString *team = [((__bridge NSDictionary *)info)[(__bridge id)kSecCodeInfoTeamIdentifier] copy];
        CFRelease(info);
        NSCharacterSet *unexpected = [[NSCharacterSet characterSetWithCharactersInString:@"ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"] invertedSet];
        if (![team isKindOfClass:NSString.class] || team.length == 0 || [team rangeOfCharacterFromSet:unexpected].location != NSNotFound) {
            CFRelease(own);
            return 1;
        }

        NSString *anchor = [NSString stringWithFormat:@"anchor apple generic and certificate leaf[subject.OU] = \"%@\"", team];
        SecRequirementRef ownRequirement = NULL;
        status = SecRequirementCreateWithString((__bridge CFStringRef)anchor, kSecCSDefaultFlags, &ownRequirement);
        if (status == errSecSuccess) {
            status = SecCodeCheckValidity(own, kSecCSStrictValidate, ownRequirement);
            CFRelease(ownRequirement);
        }
        CFRelease(own);
        if (status != errSecSuccess) return 1;

        NSString *desktopRequirement = [anchor stringByAppendingString:@" and identifier \"com.devitools.i7y\""];
        SecRequirementRef requirement = NULL;
        status = SecRequirementCreateWithString((__bridge CFStringRef)desktopRequirement, kSecCSDefaultFlags, &requirement);
        if (status != errSecSuccess) return 1;
        SecCodeRef peer = NULL;
        NSDictionary *attributes = @{(__bridge id)kSecGuestAttributePid: @(pid)};
        status = SecCodeCopyGuestWithAttributes(NULL, (__bridge CFDictionaryRef)attributes, kSecCSDefaultFlags, &peer);
        if (status == errSecSuccess) {
            status = SecCodeCheckValidity(peer, kSecCSStrictValidate, requirement);
            CFRelease(peer);
        }
        CFRelease(requirement);
        return status == errSecSuccess ? 0 : 1;
    }
}
