/**
 * App-wide icon set: Hugeicons (stroke rounded, free set). Every export keeps the name of the lucide icon it
 * replaced, so call sites only change their import path (same approach as appstyle.dev's icons.tsx).
 * Props follow lucide's API (`size`, `strokeWidth`, `color`, `className`, any SVG attribute).
 */
import { createElement, forwardRef, useId, type ForwardRefExoticComponent, type RefAttributes, type SVGProps } from 'react';
import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react';
import { mergeIconParts, type IconPart } from './iconParts';
import { CallEnd01Icon, ClipboardPasteIcon, DiceFaces03Icon } from '@hugeicons/core-free-icons';
import {
  AccessIcon, Target02Icon, ArrowExpand01Icon, ArrowShrink01Icon, PersonStandingIcon, HardDriveIcon, RoboticIcon, CreditCardIcon, ContactBookIcon, LockPasswordIcon, AiBrain01Icon, Alert02Icon, Analytics01Icon, AlertCircleIcon, ArrowDown01Icon, ArrowDown02Icon, ArrowLeft01Icon, ArrowLeft02Icon,
  ArrowRight01Icon, ArrowRight02Icon, ArrowUp01Icon, ArrowUp02Icon, Attachment01Icon, BellIcon,
  BookOpen01Icon, BubbleChatIcon, Cancel01Icon, CancelCircleIcon, CheckListIcon,
  CheckmarkCircle02Icon, Clock01Icon, ComputerIcon, ComputerPhoneSyncIcon, ComputerScreenShareIcon,
  ComputerTerminal01Icon, Copy01Icon, Delete02Icon, Download04Icon, Upload04Icon, File01Icon, FileEditIcon, FlashIcon,
  FolderOpenIcon, FolderSearchIcon, Globe02Icon, HammerIcon, Image01Icon, InformationCircleIcon, InternetIcon, CleanIcon,
  Key01Icon, LaptopIcon, LinkSquare02Icon, Login03Icon, Logout03Icon, MagicWand01Icon, Mic02Icon, Moon02Icon,
  MoreHorizontalIcon, Mortarboard02Icon, MouseLeftClick01Icon, PencilEdit01Icon, PencilEdit02Icon,
  Pin02Icon, PauseIcon, PlayIcon, Plug01Icon, PlusSignIcon, PuzzleIcon, QrCodeIcon, ReloadIcon, RepeatIcon,
  Refresh01Icon, Search01Icon, SecurityCheckIcon, SecurityIcon, SecurityWarningIcon, SentIcon,
  Settings02Icon, SmileIcon, SmartPhone01Icon, SparklesIcon, SquareIcon, StarIcon, StopIcon, Sun03Icon,
  TelegramIcon, Tick02Icon, UndoIcon, TimeScheduleIcon, TouchInteraction01Icon, UnfoldMoreIcon, Wifi01Icon, WifiOff01Icon, FilterHorizontalIcon,
  ToggleOnIcon, Wrench01Icon, BulbIcon, DashboardSquareAddIcon, DashboardSpeed02Icon, CircleArrowUp01Icon, CustomerSupportIcon,
  KeyboardIcon, Navigation03Icon, SquareTerminalIcon, TextWrapIcon, FileEmpty02Icon, ViewIcon, ViewOffSlashIcon,
  MusicNote01Icon, Video01Icon, Message01Icon, Mail01Icon, MicOff02Icon, AudioLinesIcon, SourceCodeIcon,
  CloudIcon, ScrollTextIcon, MinusSignIcon, UserGroupIcon, UserIcon, UserAdd01Icon, Crown02Icon,
} from '@hugeicons/core-free-icons';

export { HugeiconsIcon, type IconSvgElement };

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'ref'> {
  size?: number | string;
  strokeWidth?: number;
  absoluteStrokeWidth?: boolean;
  color?: string;
}

/** A renderable icon component (what lucide called `LucideIcon`). */
export type IconComponent = ForwardRefExoticComponent<IconProps & RefAttributes<SVGSVGElement>>;
/** Kept so older call sites typed with lucide's name still compile. */
export type LucideIcon = IconComponent;

/** Slightly lighter than Hugeicons' 1.5 default reads too thin on glass; 1.8 matches Akeru's AppIcon. */
export const ICON_STROKE = 1.8;
/** Line width in CSS px of icons up to 24px, so they all read with one weight. */
export const UI_LINE_PX = 1.5;

export function createIcon(icon: IconSvgElement, displayName: string): IconComponent {
  // one path wherever the strokes' styles allow, so a see-through colour lands once where they cross (iconParts.ts)
  const parts = mergeIconParts(icon as unknown as readonly IconPart[]);
  const C = forwardRef<SVGSVGElement, IconProps>(function HugeIcon(
    { size = 24, strokeWidth, absoluteStrokeWidth, color = 'currentColor', ...rest },
    ref,
  ) {
    // UI-sized icons: an even size and the same 1.5px line everywhere. At odd sizes (15, 17…) the 24-unit paths land
    // between pixels, so some icons rendered heavier than others; a line that scales with size did the same.
    const n = Number(size);
    const ui = Number.isFinite(n) && n <= 24;
    const px = ui && n % 2 ? n + 1 : size;
    const sw0 = strokeWidth ?? (ui ? (UI_LINE_PX * 24) / Number(px) : ICON_STROKE);
    const sw = absoluteStrokeWidth ? (Number(sw0) * 24) / Number(px) : Number(sw0);
    // one id per icon on screen, in letters a `url(#…)` takes as they are
    const maskId = `ic${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
    return (
      <svg
        ref={ref}
        xmlns="http://www.w3.org/2000/svg"
        width={px}
        height={px}
        viewBox="0 0 24 24"
        fill="none"
        color={color}
        aria-hidden={rest['aria-label'] ? undefined : true}
        {...rest}
      >
        {/* as Hugeicons' own renderer does once a line width is given: every part stroked at that width */}
        {parts.length === 1
          ? parts.map((p, i) => createElement('path', { ...p.attrs, key: i, d: p.d, stroke: 'currentColor', strokeWidth: sw, fill: p.attrs.fill ?? 'none' }))
          : (
            // strokes whose styles differ can't share a path (a bell's body and its clapper): they are drawn white into
            // a mask and the colour is painted once through it, so a see-through colour never doubles where they cross
            <>
              <mask id={maskId} maskUnits="userSpaceOnUse" x={-2} y={-2} width={28} height={28}>
                {parts.map((p, i) => createElement('path', { ...p.attrs, key: i, d: p.d, stroke: '#fff', strokeWidth: sw, fill: p.attrs.fill && p.attrs.fill !== 'none' ? '#fff' : 'none' }))}
              </mask>
              <rect x={-2} y={-2} width={28} height={28} fill="currentColor" mask={`url(#${maskId})`} />
            </>
          )}
      </svg>
    );
  });
  C.displayName = displayName;
  return C;
}

/* ---------- chrome & navigation ---------- */
export const Settings = createIcon(Settings02Icon, 'Settings');
export const Search = createIcon(Search01Icon, 'Search');
export const Smile = createIcon(SmileIcon, 'Smile');
export const MoreHorizontal = createIcon(MoreHorizontalIcon, 'MoreHorizontal');
export const ChevronDown = createIcon(ArrowDown01Icon, 'ChevronDown');
export const ChevronUp = createIcon(ArrowUp01Icon, 'ChevronUp');
export const ChevronLeft = createIcon(ArrowLeft01Icon, 'ChevronLeft');
export const ChevronRight = createIcon(ArrowRight01Icon, 'ChevronRight');
export const ChevronsUpDown = createIcon(UnfoldMoreIcon, 'ChevronsUpDown');
export const ArrowLeft = createIcon(ArrowLeft02Icon, 'ArrowLeft');
export const ArrowRight = createIcon(ArrowRight02Icon, 'ArrowRight');
export const ArrowUp = createIcon(ArrowUp02Icon, 'ArrowUp');
export const ArrowDown = createIcon(ArrowDown02Icon, 'ArrowDown');
export const ExternalLink = createIcon(LinkSquare02Icon, 'ExternalLink');
export const RefreshCw = createIcon(ReloadIcon, 'RefreshCw');
export const Dice = createIcon(DiceFaces03Icon, 'Dice');
/* lucide's circular arrows, ↻ and ↺ (Hugeicons' RotateLeft01/RotateRight01 are a hand's rotate gesture, which read
   as a scribble on Relaunch and Revert; its RotateCw/RotateCcw are half dotted) */
export const RotateCcw = createIcon(UndoIcon, 'RotateCcw');
export const RotateCw = createIcon(Refresh01Icon, 'RotateCw');
/** a curved arrow back (↶: undo) */
export const Undo = createIcon(UndoIcon, 'Undo');
export const LogIn = createIcon(Login03Icon, 'LogIn');
export const LogOut = createIcon(Logout03Icon, 'LogOut');

/* ---------- actions ---------- */
export const Plus = createIcon(PlusSignIcon, 'Plus');
export const X = createIcon(Cancel01Icon, 'X');
export const Check = createIcon(Tick02Icon, 'Check');
export const Copy = createIcon(Copy01Icon, 'Copy');
export const Code = createIcon(SourceCodeIcon, 'Code');
export const WrapText = createIcon(TextWrapIcon, 'WrapText');
export const Trash2 = createIcon(Delete02Icon, 'Trash2');
export const Download = createIcon(Download04Icon, 'Download');
export const Upload = createIcon(Upload04Icon, 'Upload');
export const ClipboardPaste = createIcon(ClipboardPasteIcon, 'ClipboardPaste');
export const Pencil = createIcon(PencilEdit01Icon, 'Pencil');
export const Eye = createIcon(ViewIcon, 'Eye');
export const EyeOff = createIcon(ViewOffSlashIcon, 'EyeOff');
export const PenLine = createIcon(PencilEdit02Icon, 'PenLine');
export const SquarePen = createIcon(PencilEdit02Icon, 'SquarePen');
export const Send = createIcon(SentIcon, 'Send');
export const Paperclip = createIcon(Attachment01Icon, 'Paperclip');
export const Mic = createIcon(Mic02Icon, 'Mic');
export const MicOff = createIcon(MicOff02Icon, 'MicOff');
export const PhoneOff = createIcon(CallEnd01Icon, 'PhoneOff');
export const AudioLines = createIcon(AudioLinesIcon, 'AudioLines');
export const Play = createIcon(PlayIcon, 'Play');
export const Pause = createIcon(PauseIcon, 'Pause');
export const Square = createIcon(SquareIcon, 'Square');
export const Stop = createIcon(StopIcon, 'Stop');
export const Pin = createIcon(Pin02Icon, 'Pin');
/** outlined; filled with `fill-current` on its paths (a favourite) */
export const Star = createIcon(StarIcon, 'Star');
export const Wand2 = createIcon(MagicWand01Icon, 'Wand2');
export const Sparkles = createIcon(SparklesIcon, 'Sparkles');
export const Zap = createIcon(FlashIcon, 'Zap');
export const SlidersHorizontal = createIcon(FilterHorizontalIcon, 'SlidersHorizontal');
export const Plug = createIcon(Plug01Icon, 'Plug');
/** apps (Settings › Apps and its search results, the sidebar's Connect apps, the palette's action, the cloud welcome's row): three squares and a +, the owner's pick (2026-11-27) */
export const AppsAdd = createIcon(DashboardSquareAddIcon, 'AppsAdd');
/** the account menu: the plan and how much of it is used, Upgrade plan, Support */
export const Gauge = createIcon(DashboardSpeed02Icon, 'Gauge');
export const CircleArrowUp = createIcon(CircleArrowUp01Icon, 'CircleArrowUp');
export const Headset = createIcon(CustomerSupportIcon, 'Headset');
export const ToggleLeft = createIcon(ToggleOnIcon, 'ToggleLeft');
export const Wrench = createIcon(Wrench01Icon, 'Wrench');
export const BarChart3 = createIcon(Analytics01Icon, 'BarChart3');

/* ---------- status ---------- */
export const Info = createIcon(InformationCircleIcon, 'Info');
export const AlertCircle = createIcon(AlertCircleIcon, 'AlertCircle');
export const AlertTriangle = createIcon(Alert02Icon, 'AlertTriangle');
export const CheckCircle2 = createIcon(CheckmarkCircle02Icon, 'CheckCircle2');
export const CircleCheck = CheckCircle2;
export const XCircle = createIcon(CancelCircleIcon, 'XCircle');
export const ShieldCheck = createIcon(SecurityCheckIcon, 'ShieldCheck');
export const ShieldAlert = createIcon(SecurityWarningIcon, 'ShieldAlert');
export const ShieldQuestion = createIcon(SecurityIcon, 'ShieldQuestion');
export const KeyRound = createIcon(Key01Icon, 'KeyRound');
export const WifiOff = createIcon(WifiOff01Icon, 'WifiOff');
export const Wifi = createIcon(Wifi01Icon, 'Wifi');
export const Bell = createIcon(BellIcon, 'Bell');
export const Clock = createIcon(Clock01Icon, 'Clock');

/* ---------- things ---------- */
// lucide's File is the blank folded page (Synara's read rows); FileText keeps the lines
export const File = createIcon(FileEmpty02Icon, 'File');
export const FileText = createIcon(File01Icon, 'FileText');
export const Music = createIcon(MusicNote01Icon, 'Music');
export const Video = createIcon(Video01Icon, 'Video');
export const FileEdit = createIcon(FileEditIcon, 'FileEdit');
export const FolderOpen = createIcon(FolderOpenIcon, 'FolderOpen');
export const FolderSearch = createIcon(FolderSearchIcon, 'FolderSearch');
export const Globe = createIcon(Globe02Icon, 'Globe');
// the globe for small slots (the work trail's 14px): one meridian and the equator, where Globe's four lines blur together
export const GlobeSimple = createIcon(InternetIcon, 'GlobeSimple');
export const ImageIcon = createIcon(Image01Icon, 'ImageIcon');
export const Image = ImageIcon;
export const BookOpen = createIcon(BookOpen01Icon, 'BookOpen');
export const Brain = createIcon(AiBrain01Icon, 'Brain');
export const Terminal = createIcon(ComputerTerminal01Icon, 'Terminal');
export const SquareTerminal = createIcon(SquareTerminalIcon, 'SquareTerminal');
export const Hammer = createIcon(HammerIcon, 'Hammer');
export const Blocks = createIcon(PuzzleIcon, 'Blocks');
export const CalendarClock = createIcon(TimeScheduleIcon, 'CalendarClock');
export const Target = createIcon(Target02Icon, 'Target');
export const Repeat = createIcon(RepeatIcon, 'Repeat');
export const ListChecks = createIcon(CheckListIcon, 'ListChecks');
export const MessageSquare = createIcon(BubbleChatIcon, 'MessageSquare');
export const MessageCircle = createIcon(Message01Icon, 'MessageCircle');
export const Mail = createIcon(Mail01Icon, 'Mail');
export const GraduationCap = createIcon(Mortarboard02Icon, 'GraduationCap');
export const HardDrive = createIcon(HardDriveIcon, 'HardDrive');
// clearing out what is no longer needed (Settings › Storage's Clean up now)
export const Eraser = createIcon(CleanIcon, 'Eraser');
export const Bot = createIcon(RoboticIcon, 'Bot');
export const CreditCard = createIcon(CreditCardIcon, 'CreditCard');
export const Contact = createIcon(ContactBookIcon, 'Contact');
export const LockKeyhole = createIcon(LockPasswordIcon, 'LockKeyhole');
export const Accessibility = createIcon(AccessIcon, 'Accessibility');
/** macOS's own Accessibility mark (a person, arms out), for pictures of System Settings */
export const AccessibilityPerson = createIcon(PersonStandingIcon, 'AccessibilityPerson');
export const Hand = createIcon(TouchInteraction01Icon, 'Hand');
export const MousePointerClick = createIcon(MouseLeftClick01Icon, 'MousePointerClick');
const Navigation03 = createIcon(Navigation03Icon, 'Navigation03');
/** Computer use: the pointer a bot drives, mirrored so it leans left like a cursor (as in Synara). */
export const ComputerUse: IconComponent = forwardRef<SVGSVGElement, IconProps>(function ComputerUse({ style, ...rest }, ref) {
  return <Navigation03 ref={ref} style={{ transform: 'scaleX(-1)', ...style }} {...rest} />;
});
ComputerUse.displayName = 'ComputerUse';
export const QrCode = createIcon(QrCodeIcon, 'QrCode');
export const Telegram = createIcon(TelegramIcon, 'Telegram');
export const Lightbulb = createIcon(BulbIcon, 'Lightbulb');
export const Keyboard = createIcon(KeyboardIcon, 'Keyboard');

/* ---------- devices ---------- */
export const Laptop = createIcon(LaptopIcon, 'Laptop');
export const Monitor = createIcon(ComputerIcon, 'Monitor');
export const Maximize2 = createIcon(ArrowExpand01Icon, 'Maximize2');
export const Minimize2 = createIcon(ArrowShrink01Icon, 'Minimize2');
export const MonitorUp = createIcon(ComputerScreenShareIcon, 'MonitorUp');
export const MonitorSmartphone = createIcon(ComputerPhoneSyncIcon, 'MonitorSmartphone');
export const Smartphone = createIcon(SmartPhone01Icon, 'Smartphone');
/** AppuBot Cloud: the managed computer (features/cloud) */
export const Cloud = createIcon(CloudIcon, 'Cloud');
export const Minus = createIcon(MinusSignIcon, 'Minus');
export const Users = createIcon(UserGroupIcon, 'Users');
/** a chief bot */
export const Crown = createIcon(Crown02Icon, 'Crown');
export const User = createIcon(UserIcon, 'User');
export const UserPlus = createIcon(UserAdd01Icon, 'UserPlus');
export const ScrollText = createIcon(ScrollTextIcon, 'ScrollText');

/* ---------- appearance ---------- */
export const Sun = createIcon(Sun03Icon, 'Sun');
export const Moon = createIcon(Moon02Icon, 'Moon');

/**
 * Voice mode's glyph on the composer's round button, Grok Bot's (the owner's call, 2026-11-27, after his own of
 * 2026-11-17 for a hand-drawn one): five round-capped bars, the 2nd and 4th tall, the middle one half as tall, the outer
 * two short, measured off his shot of Grok Bot's composer. Drawn here rather than from Hugeicons, as is the composer's
 * mic below.
 */
const VOICE_WAVE_BARS: readonly (readonly [number, number, number])[] = [
  [2.3, 9.2, 14.8], [7.1, 3, 21], [12, 8, 16], [16.9, 3, 21], [21.7, 9.2, 14.8],
];
export const VoiceWave: IconComponent = forwardRef<SVGSVGElement, IconProps>(function VoiceWave(
  { size = 24, strokeWidth: _sw, absoluteStrokeWidth: _a, color = 'currentColor', ...rest },
  ref,
) {
  return (
    <svg ref={ref} xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" {...rest}>
      {VOICE_WAVE_BARS.map(([x, y1, y2]) => (
        <line key={x} x1={x} x2={x} y1={y1} y2={y2} stroke={color} strokeWidth={2.6} strokeLinecap="round" />
      ))}
    </svg>
  );
}) as IconComponent;

/** The composer's mic, Grok Bot's: a filled capsule in a U-shaped cradle on a short stem, no foot. */
export const MicSolid: IconComponent = forwardRef<SVGSVGElement, IconProps>(function MicSolid(
  { size = 24, strokeWidth: _sw, absoluteStrokeWidth: _a, color = 'currentColor', ...rest },
  ref,
) {
  return (
    <svg ref={ref} xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" {...rest}>
      <rect x={8.25} y={1} width={7.5} height={14} rx={3.75} fill={color} />
      <path d="M4 8.5v.5a8 9.6 0 0 0 16 0v-.5M12 18.8V22.6" stroke={color} strokeWidth={1.9} strokeLinecap="round" />
    </svg>
  );
}) as IconComponent;
