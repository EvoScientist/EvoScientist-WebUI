// A pick-only list's trigger (Radix Select), drawn like the Input next to it
// (height, padding, background, focus ring, 16 px text below 768 px like the
// inputs): the Settings provider and the schedule builder's lists.
// globals.css sets `button { border: none }`, so the border needs its style
// back.
export const INPUT_LIKE_TRIGGER =
  "h-9 border-solid bg-transparent px-3 py-1 text-base shadow-xs md:text-sm transition-[color,box-shadow] dark:bg-input/30 focus:ring-0 focus:ring-offset-0 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50";

// The open list's height: at most 18rem, less where the window has no room.
export const LIST_MAX_HEIGHT =
  "max-h-[min(18rem,var(--radix-select-content-available-height))]";
