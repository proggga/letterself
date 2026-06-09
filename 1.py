import csv
#kicked.csv
#top500_2.csv
#top672.csv
kicked = []
top500 = []
topF = []

with open('kicked.csv', 'rt', newline='') as csvfile:
    reader = csv.reader(csvfile)
    for row in reader:
        kicked.append(row[-2])

with open('top500_2.csv', 'rt', newline='') as csvfile:
    reader = csv.reader(csvfile)
    for row in reader:
        top500.append(row[-2])

with open('top672.csv', 'rt', newline='') as csvfile:
    reader = csv.reader(csvfile)
    for row in reader:
        topF.append(row[-2])

#print(kicked)
#print(topF)
##print(top500)

x=(set(topF) - set(top500)) - set(kicked)
print("F - 500 - kicked", len(x), x)
