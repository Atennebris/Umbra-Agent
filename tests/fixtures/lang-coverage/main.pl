package Umbra::Daemon;

use strict;
use warnings;
use IO::Socket::INET;
use JSON;

our $VERSION = '1.0.0';
our $DEFAULT_PORT = 9876;
my $registry = {};

sub new {
  my ($class, %opts) = @_;
  return bless {
    host => $opts{host} // '127.0.0.1',
    port => $opts{port} // $DEFAULT_PORT,
  }, $class;
}

sub start {
  my ($self) = @_;
  print "Starting on $self->{host}:$self->{port}\n";
  return 1;
}

sub stop {
  my ($self) = @_;
  print "Stopping daemon\n";
  return 1;
}

sub handle_request {
  my ($self, $path) = @_;
  return { status => 404 } unless $path eq '/health';
  return { status => 200, body => 'OK' };
}

1;

package main;

use Umbra::Daemon;

my $daemon = Umbra::Daemon->new(host => '127.0.0.1', port => 9876);
$daemon->start();
