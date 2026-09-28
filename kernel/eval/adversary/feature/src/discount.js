// AC-01..AC-03
export function discount(total) {
  if (total < 0) throw new RangeError("total must be >= 0");
  return total >= 100 ? total * 0.9 : total;
}
