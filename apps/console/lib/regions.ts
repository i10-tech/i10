/** AWS regions by the name people know them by, for a domain's facts row. */
const REGIONS: Record<string, string> = {
  "us-east-1": "North Virginia",
  "us-east-2": "Ohio",
  "us-west-1": "North California",
  "us-west-2": "Oregon",
  "ca-central-1": "Canada",
  "sa-east-1": "Sao Paulo",
  "eu-west-1": "Ireland",
  "eu-west-2": "London",
  "eu-west-3": "Paris",
  "eu-central-1": "Frankfurt",
  "eu-north-1": "Stockholm",
  "eu-south-1": "Milan",
  "ap-south-1": "Mumbai",
  "ap-northeast-1": "Tokyo",
  "ap-northeast-2": "Seoul",
  "ap-northeast-3": "Osaka",
  "ap-southeast-1": "Singapore",
  "ap-southeast-2": "Sydney",
  "me-south-1": "Bahrain",
  "af-south-1": "Cape Town",
}

export function regionName(region: string): string {
  return REGIONS[region] ?? region
}
