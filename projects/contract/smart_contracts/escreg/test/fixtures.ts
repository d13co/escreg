export function getCollidingAppIDs(len?: number) {
  const colliding = [
    2744314563, 2870264260, 1170497781, 3051682051, 2986105595, 3146317774, 1017298967, 3098880338, 2147488012,
    2332511508,
  ]
  return colliding.slice(0, len ? len : colliding.length).map(n => BigInt(n))
}
