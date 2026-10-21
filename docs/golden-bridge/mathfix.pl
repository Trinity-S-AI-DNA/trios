#!/usr/bin/perl
# Make the compendium compile.
#
# The source is ASCII-flattened mathematics from a PDF/markdown conversion, so
# it carries two mechanical hazards that stop LaTeX dead:
#
#   1. a line ending in an unterminated math command  ($\varphi, $\cdot, $\leq)
#      -- the math span then runs on until some later $, swallowing prose, and
#      finally dies at the paragraph break;
#   2. ^ and _ sitting in text mode.
#
# This script closes (1) and escapes (2). It does NOT try to reconstruct the
# intended mathematics -- the goal is a document that builds, not one that is
# typeset correctly. Rendering the flattened notation properly is separate work.
#
# Escapes are applied only OUTSIDE $...$ spans, so real formulae are untouched.

use strict; use warnings;

# Hand-checked lines where the generic rules do not apply.
my %special = (
  'frontmatter/fm-02-attribution.tex' => [
    ['(3$\varphi$$)^{-5}', '(3$\varphi$)$^{-5}$'],
  ],
  'frontmatter/fm-09-adversarial-critique.tex' => [
    # the opening $ was consumed by an unfilled __M29__ placeholder
    ['\_\_M29\_\_\phi^2 + \phi^{-2} = 3$', '\_\_M29\_\_$\phi^2 + \phi^{-2} = 3$'],
  ],
);

my ($closed, $escaped, $spec) = (0, 0, 0);

for my $file (@ARGV) {
  open my $fh, '<:encoding(UTF-8)', $file or next;
  local $/; my $t = <$fh>; close $fh;
  my $orig = $t;

  (my $key = $file) =~ s{^\./}{};
  if (my $rules = $special{$key}) {
    for my $r (@$rules) {
      my ($from, $to) = @$r;
      if (index($t, $from) >= 0) { $t =~ s/\Q$from\E/$to/g; $spec++; }
    }
  }

  my @out;
  for my $line (split /\n/, $t, -1) {
    my $probe = $line;
    $probe =~ s/\\%//g; $probe =~ s/%.*$//; $probe =~ s/\\\$//g;

    # (1) close a line that ends mid-math
    my $n = () = $probe =~ /\$/g;
    if ($n % 2) { $line .= '$'; $closed++; $probe .= '$'; }

    # (2) escape ^ and _ that sit outside every $...$ span
    if ($probe =~ /[\^_]/) {
      my @seg = split /(\$[^\$]*\$)/, $line;
      my $hit = 0;
      for my $s (@seg) {
        next if $s =~ /^\$.*\$$/s;              # leave math alone
        $hit += ($s =~ s/(?<!\\)\^/\\textasciicircum{}/g);
        $hit += ($s =~ s/(?<!\\)_/\\_/g);
      }
      if ($hit) { $line = join '', @seg; $escaped += $hit; }
    }
    push @out, $line;
  }
  $t = join "\n", @out;

  if ($t ne $orig) {
    open my $o, '>:encoding(UTF-8)', $file or die "$file: $!";
    print $o $t; close $o;
    print "fixed  $file\n";
  }
}

print "-" x 46, "\nmath spans closed: $closed\n";
print "^/_ escaped:       $escaped\n";
print "special cases:     $spec\n";
