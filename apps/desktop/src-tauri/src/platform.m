#import <Foundation/Foundation.h>
#import <LocalAuthentication/LocalAuthentication.h>
#import <LocalAuthenticationEmbeddedUI/LocalAuthenticationEmbeddedUI.h>
#import <Security/Security.h>
#import <ApplicationServices/ApplicationServices.h>
#import <libproc.h>
#import <stdatomic.h>

static atomic_uint_fast64_t i7y_lock_events = 0;
uint64_t i7y_lock_epoch(void) {
    static dispatch_once_t once;
    static id observer;
    dispatch_once(&once, ^{
        observer = [[NSDistributedNotificationCenter defaultCenter] addObserverForName:@"com.apple.screenIsLocked" object:nil queue:nil usingBlock:^(NSNotification *notification) {
            (void)notification;
            atomic_fetch_add(&i7y_lock_events, 1);
        }];
    });
    (void)observer;
    return atomic_load(&i7y_lock_events);
}

static __weak NSWindow *i7y_auth_window;
static NSString *i7y_auth_window_request;
static LAContext *i7y_active_auth;
static NSString *i7y_active_auth_request;

void i7y_auth_window_set(void *window, const char *request) {
    i7y_auth_window = (__bridge NSWindow *)window;
    if (i7y_auth_window) {
        i7y_auth_window.opaque = NO;
        i7y_auth_window.backgroundColor = NSColor.clearColor;
        i7y_auth_window.hasShadow = YES;
        i7y_auth_window.movableByWindowBackground = YES;
        i7y_auth_window.contentView.wantsLayer = YES;
        i7y_auth_window.contentView.layer.cornerRadius = 18;
        i7y_auth_window.contentView.layer.masksToBounds = YES;
        [i7y_auth_window invalidateShadow];
    }
    i7y_auth_window_request = request ? [NSString stringWithUTF8String:request] : nil;
}
void i7y_auth_cancel(const char *request) {
    NSString *identifier = [NSString stringWithUTF8String:request];
    dispatch_async(dispatch_get_main_queue(), ^{
        if ([i7y_active_auth_request isEqualToString:identifier]) [i7y_active_auth invalidate];
    });
}
int i7y_auth(const char *reason, const char *request) {
    @autoreleasepool {
        NSString *message = [NSString stringWithUTF8String:reason];
        NSString *identifier = [NSString stringWithUTF8String:request];
        for (int attempt = 0; attempt < 2; attempt++) {
            BOOL useEmbedded = attempt == 0;
            dispatch_semaphore_t done = dispatch_semaphore_create(0);
            __block int result = 3;
            __block NSInteger errorCode = 0;
            __block LAContext *context;
            __block LAAuthenticationView *view;
            dispatch_async(dispatch_get_main_queue(), ^{
                if (i7y_active_auth) { dispatch_semaphore_signal(done); return; }
                context = [LAContext new];
                context.touchIDAuthenticationAllowableReuseDuration = 0;
                NSError *error = nil;
                if (![context canEvaluatePolicy:LAPolicyDeviceOwnerAuthentication error:&error]) {
                    result = 2;
                    dispatch_semaphore_signal(done);
                    return;
                }
                if (@available(macOS 12.0, *)) {
                    if (useEmbedded && i7y_auth_window.isVisible && [i7y_auth_window_request isEqualToString:identifier] && [context canEvaluatePolicy:LAPolicyDeviceOwnerAuthenticationWithBiometrics error:NULL]) {
                        view = [[LAAuthenticationView alloc] initWithContext:context controlSize:NSControlSizeSmall];
                        NSView *container = i7y_auth_window.contentView;
                        NSSize size = view.fittingSize;
                        CGFloat y = container.isFlipped ? container.bounds.size.height - 44 - size.height / 2 : 44 - size.height / 2;
                        view.frame = NSMakeRect(container.bounds.size.width - 50 - size.width / 2, y, size.width, size.height);
                        view.autoresizingMask = NSViewMinXMargin | (container.isFlipped ? NSViewMinYMargin : NSViewMaxYMargin);
                        [container addSubview:view positioned:NSWindowAbove relativeTo:nil];
                    }
                }
                i7y_active_auth = context;
                i7y_active_auth_request = identifier;
                [context evaluatePolicy:LAPolicyDeviceOwnerAuthentication localizedReason:message reply:^(BOOL success, NSError *error) {
                    errorCode = error.code;
                    result = success ? 0 : (error.code == LAErrorUserCancel || error.code == LAErrorSystemCancel || error.code == LAErrorAppCancel ? 1 : 3);
                    dispatch_async(dispatch_get_main_queue(), ^{
                        [view removeFromSuperview];
                        if (i7y_active_auth == context) { i7y_active_auth = nil; i7y_active_auth_request = nil; }
                        dispatch_semaphore_signal(done);
                    });
                }];
            });
            if (dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW, 120 * NSEC_PER_SEC)) != 0) {
                dispatch_async(dispatch_get_main_queue(), ^{
                    [context invalidate];
                    [view removeFromSuperview];
                    if (i7y_active_auth == context) { i7y_active_auth = nil; i7y_active_auth_request = nil; }
                });
                return 1;
            }
            if (result != 0 && attempt == 0 && view && (errorCode == LAErrorUserFallback || errorCode == LAErrorBiometryLockout || errorCode == LAErrorBiometryNotAvailable || errorCode == LAErrorBiometryNotEnrolled)) continue;
            return result;
        }
        return 3;
    }
}
int i7y_locked(void) {
    CFDictionaryRef session = CGSessionCopyCurrentDictionary();
    if (!session) return 1;
    NSDictionary *data = (__bridge NSDictionary *)session;
    BOOL locked = [data[@"CGSSessionScreenIsLocked"] boolValue] || ![data[(__bridge NSString *)kCGSessionOnConsoleKey] boolValue];
    CFRelease(session);
    return locked ? 1 : 0;
}
char *i7y_secret_read(const char *account) {
    @autoreleasepool {
        NSDictionary *query = @{(__bridge id)kSecClass:(__bridge id)kSecClassGenericPassword,(__bridge id)kSecAttrService:@"com.devitools.i7y.session",(__bridge id)kSecAttrAccount:[NSString stringWithUTF8String:account],(__bridge id)kSecReturnData:@YES};
        CFTypeRef result = NULL;
        if (SecItemCopyMatching((__bridge CFDictionaryRef)query, &result) != errSecSuccess) return NULL;
        NSData *data = CFBridgingRelease(result);
        NSString *value = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
        return value ? strdup(value.UTF8String) : NULL;
    }
}
int i7y_secret_write(const char *account, const char *value) {
    @autoreleasepool {
        NSDictionary *query = @{(__bridge id)kSecClass:(__bridge id)kSecClassGenericPassword,(__bridge id)kSecAttrService:@"com.devitools.i7y.session",(__bridge id)kSecAttrAccount:[NSString stringWithUTF8String:account]};
        if (!value) { OSStatus s=SecItemDelete((__bridge CFDictionaryRef)query); return s==errSecSuccess || s==errSecItemNotFound ? 0 : 1; }
        NSData *data = [[NSString stringWithUTF8String:value] dataUsingEncoding:NSUTF8StringEncoding];
        OSStatus status = SecItemUpdate((__bridge CFDictionaryRef)query, (__bridge CFDictionaryRef)@{(__bridge id)kSecValueData:data});
        if (status == errSecItemNotFound) {
            NSMutableDictionary *item=[query mutableCopy];item[(__bridge id)kSecValueData]=data;item[(__bridge id)kSecAttrAccessible]=(__bridge id)kSecAttrAccessibleWhenUnlockedThisDeviceOnly;
            status=SecItemAdd((__bridge CFDictionaryRef)item,NULL);
        }
        return status==errSecSuccess ? 0 : 1;
    }
}
int i7y_verify_peer(int pid, const char *expected, int development) {
    @autoreleasepool {
        char path[PROC_PIDPATHINFO_MAXSIZE];
        if (proc_pidpath(pid,path,sizeof(path))<=0 || strcmp(path,expected)!=0) return 1;
        if (development) return 0;
        SecCodeRef own=NULL,peer=NULL;
        CFDictionaryRef info=NULL;
        if (SecCodeCopySelf(kSecCSDefaultFlags,&own)!=errSecSuccess) return 1;
        OSStatus status=SecCodeCopySigningInformation(own,kSecCSSigningInformation,&info);
        CFRelease(own);
        if (status!=errSecSuccess) return 1;
        NSString *team=((__bridge NSDictionary *)info)[(__bridge id)kSecCodeInfoTeamIdentifier];
        NSString *requirement=team ? [NSString stringWithFormat:@"anchor apple generic and certificate leaf[subject.OU] = \"%@\"",team] : nil;
        SecRequirementRef req=NULL;
        BOOL valid=requirement && SecRequirementCreateWithString((__bridge CFStringRef)requirement,kSecCSDefaultFlags,&req)==errSecSuccess;
        CFRelease(info);
        if (!valid) return 1;
        NSDictionary *attrs=@{(__bridge id)kSecGuestAttributePid:@(pid)};
        status=SecCodeCopyGuestWithAttributes(NULL,(__bridge CFDictionaryRef)attrs,kSecCSDefaultFlags,&peer);
        if (status==errSecSuccess) {status=SecCodeCheckValidity(peer,kSecCSStrictValidate,req);CFRelease(peer);}
        CFRelease(req);
        return status==errSecSuccess ? 0 : 1;
    }
}
