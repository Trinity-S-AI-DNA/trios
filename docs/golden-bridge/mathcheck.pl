#!/usr/bin/perl
# Report LaTeX math-mode hazards in the compendium.
#   odd-$   : a line with an unbalanced number of inline-math delimiters
#   bare^_  : ^ or _ used outside any $...$ span on the line
# Escaped \$ and comment tails are ignored.
# Run: perl mathcheck.pl $(find . -name '*.tex')

use strict; use warnings;

my ($odd, $bare) = (0, 0);
for my $file (@ARGV) {
  open my $fh, '<:encoding(UTF-8)', $file or next;
  my $ln = 0;
  while (my $l = <$fh>) {
    $ln++;
    my $s = $l;
    $s =~ s/\\%//g;
    $s =~ s/%.*$//;            # strip comment tail
    $s =~ s/\\\$//g;           # strip escaped dollars
    my $n = () = $s =~ /\$/g;
    if ($n % 2) { $odd++; printf "odd-\$   %s:%d\n", $file, $ln; next; }

    # blank out every $...$ span, then look for leftover ^ or _
    my $t = $s;
    $t =~ s/\$[^\$]*\$/ /g;
    if ($t =~ /[\^_]/) {
      # \_ and \^ are legitimate escapes
      my $u = $t; $u =~ s/\\[\^_]//g;
      if ($u =~ /[\^_]/) { $bare++; printf "bare^_  %s:%d\n", $file, $ln; }
    }
  }
  close $fh;
}
print "-" x 46, "\nodd-\$ lines: $odd    bare ^/_ lines: $bare\n";
