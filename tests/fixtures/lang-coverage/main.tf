terraform {
  required_version = ">= 1.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.aws_region
}

variable "aws_region" {
  description = "AWS region"
  default     = "us-east-1"
}

variable "app_name" {
  description = "Application name"
  default     = "umbra"
}

data "aws_ami" "ubuntu" {
  most_recent = true
  owners      = ["099720109477"]
}

resource "aws_instance" "daemon" {
  ami           = data.aws_ami.ubuntu.id
  instance_type = "t3.small"
  tags = {
    Name = "${var.app_name}-daemon"
  }
}

resource "aws_s3_bucket" "storage" {
  bucket = "${var.app_name}-storage"
}

module "vpc" {
  source  = "terraform-aws-modules/vpc/aws"
  version = "~> 5.0"
  name    = var.app_name
}

output "daemon_ip" {
  value = aws_instance.daemon.public_ip
}

locals {
  common_tags = {
    Project = var.app_name
  }
}
