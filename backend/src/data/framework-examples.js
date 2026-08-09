// Few-shot issue-tree examples used to steer Claude's structuring output.
// Reconstructed from real MECE framework diagrams in the Yale Graduate
// Student Consulting Club 2013 casebook (Animal Drug, Apoplexy Drug,
// Surgical Robot, 7-Eleven, Taxi Service, Diabetes Device cases).
// Each tree: root = the case question, children branch out MECE-style,
// with a further level of sub-branches. This is the shape we want the
// model to produce for the candidate's spoken framework.

const EXAMPLES = {
  market_entry: {
    question: 'Should our client enter the prenatal diagnostic test market?',
    tree: {
      label: 'Should our client enter the prenatal diagnostic test market?',
      children: [
        { label: 'Market', children: [
          { label: 'Size', children: [] },
          { label: 'Growth', children: [] },
          { label: 'Customer segments', children: [] }
        ]},
        { label: 'Competitors', children: [
          { label: 'Number', children: [] },
          { label: 'Fragmentation', children: [] }
        ]},
        { label: 'Company', children: [
          { label: 'Capacity & expertise', children: [] },
          { label: 'Revenues', children: [] },
          { label: 'Costs', children: [] }
        ]},
        { label: 'Product', children: [
          { label: 'Exclusivity of technology', children: [] },
          { label: 'Profitability', children: [
            { label: 'Revenue per unit', children: [] },
            { label: 'Cost per unit', children: [] }
          ]}
        ]}
      ]
    }
  },

  growth: {
    question: 'Should our client relocate manufacturing to China?',
    tree: {
      label: 'Should our client relocate manufacturing to China?',
      children: [
        { label: 'Customer', children: [
          { label: 'Existing preferences', children: [] },
          { label: 'Segmentation', children: [] }
        ]},
        { label: 'Competition', children: [
          { label: 'Segmentation', children: [] },
          { label: 'Growth', children: [] }
        ]},
        { label: 'Product', children: [
          { label: 'Quality control', children: [] },
          { label: 'Profitability', children: [] }
        ]},
        { label: 'Barriers to entry', children: [
          { label: 'Governmental policies', children: [] },
          { label: 'Reputation', children: [] }
        ]}
      ]
    }
  },

  decision: {
    question: 'Should the hospital invest in the new surgical robot?',
    tree: {
      label: 'Should the hospital invest in the new surgical robot?',
      children: [
        { label: 'Product', children: [
          { label: 'Benefits', children: [
            { label: 'Cost reduction', children: [] },
            { label: 'Effectiveness', children: [] }
          ]},
          { label: 'Costs', children: [
            { label: 'Upfront', metric: { before: '3.2', after: '3.2', unit: '$M one-time' }, children: [] },
            { label: 'Maintenance', metric: { before: '200', after: '200', unit: '$K/year' }, children: [] }
          ]}
        ]},
        { label: 'Stakeholders', children: [
          { label: 'Patients', children: [] },
          { label: 'Operators', children: [
            { label: 'Surgeons', children: [] },
            { label: 'Support staff', children: [] }
          ]},
          { label: 'Board of directors', children: [
            { label: 'Purchasing department', children: [] }
          ]}
        ]},
        { label: 'Market trends', children: [
          { label: 'Current technology', children: [] }
        ]}
      ]
    }
  },

  operations: {
    question: 'Should the hospital invest in the new surgical robot?',
    tree: {
      label: 'Should the hospital invest in the new surgical robot?',
      children: [
        { label: 'Product', children: [
          { label: 'Benefits', children: [
            { label: 'Cost reduction', children: [] },
            { label: 'Effectiveness', children: [] }
          ]},
          { label: 'Costs', children: [
            { label: 'Upfront', children: [] },
            { label: 'Maintenance', children: [] }
          ]}
        ]},
        { label: 'Stakeholders', children: [
          { label: 'Patients', children: [] },
          { label: 'Operators', children: [] },
          { label: 'Board of directors', children: [] }
        ]},
        { label: 'Market trends', children: [] }
      ]
    }
  },

  profitability: {
    question: 'Why has our client’s profit declined, and how can it be improved?',
    tree: {
      label: 'Why has profit declined?',
      children: [
        { label: 'Revenue', children: [
          { label: 'Price per unit', children: [] },
          { label: 'Volume', children: [
            { label: 'Number of customers', metric: { before: '250', after: '210', unit: 'customers/hour' }, children: [
              { label: 'Population density', children: [] },
              { label: 'Market penetration', children: [] }
            ]},
            { label: 'Competition', children: [] }
          ]}
        ]},
        { label: 'Costs', children: [
          { label: 'Fixed costs', children: [] },
          { label: 'Variable costs', children: [] }
        ]}
      ]
    }
  },

  ma: {
    question: 'Should our client acquire TaxiCall?',
    tree: {
      label: 'Should our client acquire TaxiCall?',
      children: [
        { label: 'Market', children: [
          { label: 'Growth', children: [] },
          { label: 'Customers', children: [
            { label: 'Existing', children: [] },
            { label: 'Future', children: [] }
          ]},
          { label: 'Competitors', children: [
            { label: 'Market share', children: [] }
          ]}
        ]},
        { label: 'Company valuation', children: [
          { label: 'Profitability', children: [
            { label: 'Revenues', children: [] },
            { label: 'Costs', children: [] }
          ]},
          { label: 'Assets & liabilities', children: [] }
        ]},
        { label: 'Implementation', children: [
          { label: 'ROI', children: [
            { label: 'Gains', children: [] },
            { label: 'Costs', children: [] }
          ]}
        ]}
      ]
    }
  },

  pricing: {
    question: 'How should our client price the injector and cartridge?',
    tree: {
      label: 'How should our client price the injector and cartridge?',
      children: [
        { label: 'Cost-based floor', children: [
          { label: 'Unit cost', children: [] },
          { label: 'Target margin', children: [] }
        ]},
        { label: 'Demand-based ceiling', children: [
          { label: 'Willingness to pay', children: [] },
          { label: 'Price elasticity', metric: { before: '80%', after: '60%', unit: 'take-rate at $60 vs $68' }, children: [] }
        ]},
        { label: 'Competitive benchmark', children: [
          { label: 'Competitor pricing', children: [] }
        ]},
        { label: 'Bundling strategy', children: [
          { label: 'Bundle ratio economics', children: [] },
          { label: 'Customer attractiveness', children: [] }
        ]}
      ]
    }
  }
};

// case-bank.json uses these type keys; map the ones without a dedicated
// example onto the closest analog above.
const FALLBACK_MAP = {
  competitive_response: 'market_entry',
  product_launch: 'market_entry',
  sizing: 'profitability'
};

function getExampleForType(type) {
  return EXAMPLES[type] || EXAMPLES[FALLBACK_MAP[type]] || EXAMPLES.profitability;
}

module.exports = { getExampleForType };
