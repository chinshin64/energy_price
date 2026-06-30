// switch-city.js - Automated city switching for WeChat mini program
// Usage: osascript -l JavaScript switch-city.js <city_name> <window_id> <window_x> <window_y> <window_w> <window_h>

ObjC.import('Cocoa');
ObjC.import('CoreGraphics');

var args = $.NSProcessInfo.processInfo.arguments;
var cityName = ObjC.unwrap(args.objectAtIndex(3));
var windowId = parseInt(ObjC.unwrap(args.objectAtIndex(4)));
var wxX = parseInt(ObjC.unwrap(args.objectAtIndex(5)));
var wxY = parseInt(ObjC.unwrap(args.objectAtIndex(6)));
var wxW = parseInt(ObjC.unwrap(args.objectAtIndex(7)));
var wxH = parseInt(ObjC.unwrap(args.objectAtIndex(8)));

// Helper: click at absolute screen coordinates
function clickAt(x, y) {
    var src = $.CGEventSourceCreate($.kCGEventSourceStateHIDSystemState);
    var down = $.CGEventCreateMouseEvent(src, $.kCGEventLeftMouseDown, $.CGPointMake(x, y), $.kCGMouseButtonLeft);
    var up = $.CGEventCreateMouseEvent(src, $.kCGEventLeftMouseUp, $.CGPointMake(x, y), $.kCGMouseButtonLeft);
    $.CGEventPost($.kCGHIDEventTap, down);
    $.CGEventPost($.kCGHIDEventTap, up);
}

// Helper: type text
function typeText(text) {
    var src = $.CGEventSourceCreate($.kCGEventSourceStateHIDSystemState);
    for (var i = 0; i < text.length; i++) {
        var ch = text.charCodeAt(i);
        var down = $.CGEventCreateKeyboardEvent(src, 0, true);
        $.CGEventKeyboardSetUnicodeString(down, 1, [ch]);
        var up = $.CGEventCreateKeyboardEvent(src, 0, false);
        $.CGEventKeyboardSetUnicodeString(up, 1, [ch]);
        $.CGEventPost($.kCGHIDEventTap, down);
        $.CGEventPost($.kCGHIDEventTap, up);
    }
}

// Step 1: Click on the city selector area (top-left of the mini program)
// The city name like "杭州市、" is typically at the top-left corner
var cityBtnX = wxX + 50;  // approximately 12% from left
var cityBtnY = wxY + 20;  // approximately 3% from top

clickAt(cityBtnX, cityBtnY);

// Wait for city search to open
delay(1.5);

// Step 2: Click on the search input area
// The search input is in the middle-top area
var searchInputX = wxX + wxW * 0.5;
var searchInputY = wxY + wxH * 0.08;

clickAt(searchInputX, searchInputY);
delay(0.5);

// Step 3: Type the city name
typeText(cityName);
delay(1.0);

// Step 4: Click on the first search result
// The results appear below the search box
var resultX = wxX + wxW * 0.3;
var resultY = wxY + wxH * 0.25;

clickAt(resultX, resultY);
delay(1.5);

"OK";
