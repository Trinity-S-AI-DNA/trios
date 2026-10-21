#!/usr/bin/perl
# Pass 3: attach the five remaining references.bib entries to the places where
# the text already discusses them, so the printed bibliography is complete
# rather than a subset.

use strict; use warnings;

my @rules = (
  ['the Benjamini--Hochberg (BH) procedure is applied to the ranked p-values at the',
   'the Benjamini--Hochberg (BH) procedure \citep{bh1995} is applied to the ranked p-values at the'],

  ['increasing C indefinitely. The Pellis',
   'increasing C indefinitely. The Pellis \citep{pellis2021alpha}'],

  ["Olsen's book The Golden Section: Nature's Greatest",
   "Olsen's book \\citep{olsen2006} The Golden Section: Nature's Greatest"],
);

my $total = 0;
for my $file (@ARGV) {
  open my $fh, '<:encoding(UTF-8)', $file or next;
  local $/; my $t = <$fh>; close $fh;
  my $before = $t; my $n = 0;
  for my $r (@rules) { my ($from,$to) = @$r; $n += ($t =~ s/\Q$from\E/$to/g); }
  if ($t ne $before) {
    open my $o, '>:encoding(UTF-8)', $file or die "$file: $!";
    print $o $t; close $o;
    printf "%-36s %2d\n", $file, $n;
    $total += $n;
  }
}
print "-" x 42, "\npass 3 inserted: $total\n";
